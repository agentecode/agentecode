/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { computeReview, splitReviewed, fingerprint, listBases } = require('./review');
const { computeHunks, revertHunkInText } = require('./reviewHunks');
const { languageBadge } = require('./reviewPanelLib');
const { renderPanelHtml } = require('./reviewPanelHtml');
const { isInsideAny, BACKUP_NAME } = require('./checkpoints');
const { listSessions, fileHistoryDir } = require('./sessionStore');
const { applyChange } = require('./rewindPlan');
const { rewindToCheckpoint, undoLastRewind, saveUndoPoint } = require('./rewind');
const { claudeConfigDir, projectSlug } = require('./sessionMarkdown');
const gs = require('./gitSnapshot');
const { TurnWatcher } = require('./turnWatcher');
const { computeTerminalChanges } = require('./terminalChanges');

const VIEW_ID = 'agentecode.review';
const PANEL_ID = 'agentecode.reviewPanel';
const SCM_ID = 'agentecode-review';
const SCHEME = 'agentecode-review';
const REVIEWED_KEY = 'agentecode.review.reviewed';
const KEPT_HUNKS_KEY = 'agentecode.review.keptHunks';
const MAX_LENS_CHARS = 1024 * 1024;
/** Sinais invisiveis no fim do titulo do CodeLens: o editor do AgenteCode desenha esses itens como botoes. */
const KEEP_MARK = '\u2063';
const UNDO_MARK = '\u2064';
const LABEL_MARK = String.fromCharCode(0x2060);
/** Caixa que aparece ao passar o mouse sobre o rotulo em italico (o rotulo nao e clicavel). */
const LABEL_TOOLTIP = [
	'Alterado pelo agente nesta conversa.',
	'',
	'Alt+Y: manter este trecho',
	'Alt+N: desfazer este trecho',
	'Clique em +N −M para ver a diferença (antes ↔ agora).'
].join('\n');
const REFRESH_MS = 15000;
const EMPTY = 'none';

const STATUS = {
	modified: { text: 'modificado', icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
	added: { text: 'novo', icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
	deleted: { text: 'excluído', icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground' }
};

/** Chave de comparacao de caminhos (no Windows nao diferencia maiusculas). */
const keyOf = file => (process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file));

/** Mostra o conteudo da copia (checkpoint) com o nome do arquivo original, para ter realce de sintaxe no diff. */
class BackupContentProvider {
	/** @param {string} beforeDir pasta com o antes dos arquivos alterados por terminal */
	constructor(beforeDir) {
		this.beforeDir = beforeDir;
	}

	provideTextDocumentContent(uri) {
		const { session, backup, external } = JSON.parse(uri.query);
		if (backup === EMPTY) {
			return '';
		}
		if (external) {
			return /^[0-9a-f]{40}$/.test(backup) ? fs.promises.readFile(path.join(this.beforeDir, backup), 'utf8').catch(() => '') : '';
		}
		if (!BACKUP_NAME.test(backup) || !/^[0-9a-f-]+$/i.test(session)) {
			return '';
		}
		return fs.promises.readFile(path.join(fileHistoryDir(session), backup), 'utf8').catch(() => '');
	}
}

function backupUri(sessionId, file, backup, external = false) {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${path.basename(file)}`, query: JSON.stringify({ session: sessionId, backup: backup ? path.basename(backup) : EMPTY, external }) });
}

/** @param {vscode.ExtensionContext} context */
function registerReviewView(context) {
	/** Antes dos arquivos alterados por terminal, tirado das fotos do git (para o diff e o Desfazer). */
	const beforeDir = path.join(context.globalStorageUri.fsPath, 'terminal-before');
	/** @type {{ file: string, id: string, cwd?: string, title?: string } | undefined} */
	let session;
	let review;
	let hidden = 0;
	let showReviewed = false;
	/** `true` quando o usuario escolheu a conversa; senao acompanha a mais recente da pasta. */
	let pinned = false;
	/** Turno usado como ponto de comparacao; `undefined` = inicio da conversa. */
	let base;
	let loading;
	/** @type {Map<string, any>} arquivos a revisar, por caminho normalizado */
	let pendingByKey = new Map();

	const treeEmitter = new vscode.EventEmitter();
	const decorationEmitter = new vscode.EventEmitter();
	const roots = () => {
		const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
		return folders.length ? folders : session?.cwd ? [session.cwd] : [];
	};
	const reviewedMap = () => context.workspaceState.get(REVIEWED_KEY, {});

	// --- Arvore na barra lateral das sessoes ---
	const view = vscode.window.createTreeView(VIEW_ID, {
		treeDataProvider: {
			onDidChangeTreeData: treeEmitter.event,
			getChildren: element => (element || !review ? [] : (showReviewed ? review.all : review.pending)),
			getTreeItem: element => {
				const info = STATUS[element.status];
				const item = new vscode.TreeItem(vscode.Uri.file(element.file), vscode.TreeItemCollapsibleState.None);
				const root = roots().find(r => isInsideAny(element.file, [r]));
				const relDir = root ? path.dirname(path.relative(root, element.file)) : path.dirname(element.file);
				const counts = element.added === null ? '' : ` +${element.added} −${element.removed}`;
				item.description = `${relDir === '.' ? '' : `${relDir}  `}${info.text}${counts}${element.source === 'terminal' ? ' · terminal' : ''}`;
				item.iconPath = new vscode.ThemeIcon(info.icon, new vscode.ThemeColor(info.color));
				item.contextValue = 'reviewFile';
				item.tooltip = `${element.file}\n${info.text}${counts}`;
				item.command = { command: 'agentecode.review.open', title: 'Ver diferença', arguments: [element] };
				return item;
			}
		},
		showCollapseAll: false
	});

	// --- Controle de codigo-fonte: barras na margem do editor, lista no painel Ctrl+Shift+G ---
	// Sem pasta raiz: o nome na lista de repositorios e o do proprio painel, e a margem vale para qualquer arquivo
	const scm = vscode.scm.createSourceControl(SCM_ID, 'Alterações do agente');
	scm.inputBox.visible = false;
	scm.quickDiffProvider = {
		provideOriginalResource: uri => {
			const item = uri.scheme === 'file' ? pendingByKey.get(keyOf(uri.fsPath)) : undefined;
			return item && item.status !== 'deleted' && session ? backupUri(session.id, item.file, item.backup, item.source === 'terminal') : undefined;
		}
	};
	const scmGroup = scm.createResourceGroup('changes', 'Alterações do agente');
	scmGroup.hideWhenEmpty = true;

	// --- Marca "IA" no Explorer ---
	const decorations = {
		onDidChangeFileDecorations: decorationEmitter.event,
		provideFileDecoration: uri => (uri.scheme === 'file' && pendingByKey.has(keyOf(uri.fsPath))
			? { badge: 'IA', tooltip: 'Alterado pelo agente e ainda não revisado', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), propagate: false }
			: undefined)
	};

	// --- Manter / Desfazer por trecho, dentro do proprio arquivo (CodeLens acima de cada trecho alterado) ---
	const lensEmitter = new vscode.EventEmitter();
	/** @type {Map<string, string>} copias de antes ja lidas (nunca mudam) */
	const backupTexts = new Map();
	const keptMap = () => context.workspaceState.get(KEPT_HUNKS_KEY, {});

	const readBackupText = async item => {
		if (!item.backup) {
			return '';
		}
		let text = backupTexts.get(item.backup);
		if (text === undefined) {
			text = await fs.promises.readFile(item.backup, 'utf8').catch(() => '');
			backupTexts.set(item.backup, text);
		}
		return text;
	};

	/** Trechos ainda nao mantidos de um arquivo, comparando o texto atual do editor com a copia de antes. */
	const pendingHunks = async (item, text) => {
		const kept = new Set(keptMap()[item.file] ?? []);
		return computeHunks(await readBackupText(item), text).filter(h => !kept.has(h.key));
	};

	const lensProvider = {
		onDidChangeCodeLenses: lensEmitter.event,
		provideCodeLenses: async document => {
			if (!vscode.workspace.getConfiguration('agentecode.review').get('codeLens', true)) {
				return [];
			}
			const item = pendingByKey.get(keyOf(document.uri.fsPath));
			if (!item || item.status === 'deleted' || document.getText().length > MAX_LENS_CHARS) {
				return [];
			}
			const hunks = await pendingHunks(item, document.getText());
			if (item.status === 'added') {
				if (!hunks.length) {
					return [];
				}
				const top = new vscode.Range(0, 0, 0, 0);
				return [
					new vscode.CodeLens(top, { title: `$(check) Manter${KEEP_MARK}`, tooltip: 'Manter o arquivo novo', command: 'agentecode.review.keep', arguments: [item] }),
					new vscode.CodeLens(top, { title: `$(trash) Excluir${UNDO_MARK}`, tooltip: 'Excluir o arquivo novo', command: 'agentecode.review.revert', arguments: [item] }),
					new vscode.CodeLens(top, { title: `$(diff) +${hunks[0].afterLines.length} −0`, tooltip: 'Ver o arquivo', command: 'agentecode.review.open', arguments: [item] }),
					new vscode.CodeLens(top, { title: `✦ agente · arquivo novo${LABEL_MARK}`, tooltip: LABEL_TOOLTIP, command: 'agentecode.review.open', arguments: [item] })
				];
			}
			return hunks.flatMap(hunk => {
				const line = Math.min(hunk.modStart, Math.max(0, document.lineCount - 1));
				const range = new vscode.Range(line, 0, line, 0);
				return [
					new vscode.CodeLens(range, { title: `$(check) Manter${KEEP_MARK}`, tooltip: 'Manter este trecho (Alt+Y)', command: 'agentecode.review.keepHunk', arguments: [document.uri, hunk.key] }),
					new vscode.CodeLens(range, { title: `$(discard) Desfazer${UNDO_MARK}`, tooltip: 'Desfazer este trecho (Alt+N)', command: 'agentecode.review.undoHunk', arguments: [document.uri, hunk.key] }),
					new vscode.CodeLens(range, { title: `$(diff) +${hunk.afterLines.length} −${hunk.beforeLines.length}`, tooltip: 'Ver a diferença (antes ↔ agora)', command: 'agentecode.review.open', arguments: [item] }),
					new vscode.CodeLens(range, { title: `✦ agente · Alt+Y manter · Alt+N desfazer${LABEL_MARK}`, tooltip: LABEL_TOOLTIP, command: 'agentecode.review.open', arguments: [item] })
				];
			});
		}
	};

	context.subscriptions.push(
		view, treeEmitter, decorationEmitter, lensEmitter, scm, scmGroup,
		vscode.window.registerFileDecorationProvider(decorations),
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lensProvider),
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, new BackupContentProvider(beforeDir))
	);

	// --- Rotulo em italico e na cor do tema no fim da primeira linha de cada trecho (como no Antigravity) ---
	const hintType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' }
	});
	const asUri = value => (typeof value === 'string' ? vscode.Uri.parse(value) : value);
	const commandLink = (command, uri, key, label) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify([uri.toString(), key]))})`;

	async function updateInlineHints(editor) {
		if (!editor || editor.document.uri.scheme !== 'file') {
			return;
		}
		const enabled = vscode.workspace.getConfiguration('agentecode.review').get('inlineHint', true);
		const item = enabled ? pendingByKey.get(keyOf(editor.document.uri.fsPath)) : undefined;
		if (!item || item.status !== 'modified' || editor.document.getText().length > MAX_LENS_CHARS) {
			editor.setDecorations(hintType, []);
			return;
		}
		const hunks = await pendingHunks(item, editor.document.getText());
		editor.setDecorations(hintType, hunks.map(hunk => {
			const line = Math.min(hunk.modStart, Math.max(0, editor.document.lineCount - 1));
			const hover = new vscode.MarkdownString(
				`**Alterado pelo agente** · +${hunk.afterLines.length} −${hunk.beforeLines.length}\n\n` +
				`${commandLink('agentecode.review.keepHunk', editor.document.uri, hunk.key, '$(check) Manter')} &nbsp;·&nbsp; ${commandLink('agentecode.review.undoHunk', editor.document.uri, hunk.key, '$(discard) Desfazer')}\n\n` +
				'Atalhos: **Alt+Y** manter · **Alt+N** desfazer'
			);
			hover.isTrusted = true;
			hover.supportThemeIcons = true;
			return { range: editor.document.lineAt(line).range, hoverMessage: hover, renderOptions: { after: { contentText: '✦ agente · Alt+Y manter · Alt+N desfazer' } } };
		}));
	}
	const updateAllHints = () => vscode.window.visibleTextEditors.forEach(editor => void updateInlineHints(editor));
	let hintTimer;
	context.subscriptions.push(
		hintType,
		lensEmitter.event(updateAllHints),
		vscode.window.onDidChangeVisibleTextEditors(updateAllHints),
		vscode.workspace.onDidChangeTextDocument(() => {
			clearTimeout(hintTimer);
			hintTimer = setTimeout(updateAllHints, 400);
		}),
		{ dispose: () => clearTimeout(hintTimer) }
	);

	/** Trecho sob o cursor do editor ativo (para os atalhos Alt+Y e Alt+N). */
	async function hunkAtCursor() {
		const editor = vscode.window.activeTextEditor;
		const item = editor ? pendingByKey.get(keyOf(editor.document.uri.fsPath)) : undefined;
		if (!editor || !item || item.status !== 'modified') {
			return undefined;
		}
		const line = editor.selection.active.line;
		const hunk = (await pendingHunks(item, editor.document.getText())).find(h => line >= h.modStart && line < Math.max(h.modEnd, h.modStart + 1));
		return hunk ? { uri: editor.document.uri, key: hunk.key } : undefined;
	}

	async function chooseDefaultSession() {
		const all = await listSessions((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath), 30);
		return all.find(s => s.size > 0);
	}


	// --- Tela "Alteracoes do agente" em webview (botoes, selos, numeros coloridos e trechos expansiveis) ---
	/** @type {Set<string>} arquivos com a lista de trechos aberta */
	const expanded = new Set();
	/** @type {vscode.WebviewView | undefined} */
	let panelView;

	async function buildPanelState() {
		const items = review ? (showReviewed ? review.all : review.pending) : [];
		const pending = review ? review.pending : [];
		const pendingKeys = new Set(pending.map(i => keyOf(i.file)));
		const sum = key => pending.reduce((total, item) => total + (item[key] ?? 0), 0);
		const rows = [];
		for (const item of items) {
			const key = keyOf(item.file);
			const root = roots().find(r => isInsideAny(item.file, [r]));
			const relDir = root ? path.dirname(path.relative(root, item.file)) : path.dirname(item.file);
			const row = {
				file: item.file,
				name: path.basename(item.file),
				dir: relDir === '.' ? '' : relDir,
				status: item.status,
				added: item.added,
				removed: item.removed,
				badge: languageBadge(item.file),
				source: item.source,
				approx: Boolean(item.approx),
				reviewed: !pendingKeys.has(key),
				expanded: expanded.has(key)
			};
			if (row.expanded && item.status === 'modified') {
				try {
					const text = await fs.promises.readFile(item.file, 'utf8');
					row.hunks = (await pendingHunks(item, text)).map(h => ({ key: h.key, line: h.modStart + 1, added: h.afterLines.length, removed: h.beforeLines.length }));
				} catch {
					row.hunks = [];
				}
			}
			rows.push(row);
		}
		let emptyText = '';
		if (!session) {
			emptyText = 'Nenhuma conversa do agente encontrada para esta pasta.';
		} else if (!review || (!review.firstMessageId && !review.all.length)) {
			emptyText = 'Esta conversa ainda não alterou arquivos.';
		} else if (!rows.length) {
			emptyText = hidden ? `Tudo revisado (${hidden}).` : 'Nenhuma diferença: os arquivos estão como antes.';
		}
		return {
			conversation: session ? (session.title ?? session.id) : '',
			base: base ? `antes de "${base.prompt.slice(0, 40)}"` : 'o início da conversa',
			totals: { files: pending.length, added: sum('added'), removed: sum('removed') },
			hiddenReviewed: hidden,
			showReviewed,
			items: rows,
			emptyText,
			terminalNote: review ? terminalNote(review.terminalMode) : ''
		};
	}

	async function postPanel() {
		if (!panelView) {
			return;
		}
		try {
			await panelView.webview.postMessage({ type: 'state', state: await buildPanelState() });
		} catch {
			// a tela pode ter sido fechada no meio
		}
	}

	const itemOf = file => (review ? review.all.find(i => keyOf(i.file) === keyOf(file)) : undefined);

	async function handlePanelMessage(message) {
		const item = message.file ? itemOf(message.file) : undefined;
		switch (message.type) {
			case 'ready':
			case 'refresh':
				await reload();
				await postPanel();
				break;
			case 'open':
				if (item) {
					await vscode.commands.executeCommand('agentecode.review.open', item);
				}
				break;
			case 'toggle':
				if (item) {
					const key = keyOf(item.file);
					if (!expanded.delete(key)) {
						expanded.add(key);
					}
					await postPanel();
				}
				break;
			case 'keep':
				if (item) {
					await vscode.commands.executeCommand('agentecode.review.keep', item);
				}
				break;
			case 'revert':
				if (item) {
					await vscode.commands.executeCommand('agentecode.review.revert', item);
				}
				break;
			case 'keepHunk':
			case 'undoHunk':
				if (item) {
					await vscode.commands.executeCommand(`agentecode.review.${message.type}`, vscode.Uri.file(item.file).toString(), message.key);
					await postPanel();
				}
				break;
			case 'goto':
				if (item) {
					const line = Math.max(0, (message.line ?? 1) - 1);
					await vscode.window.showTextDocument(vscode.Uri.file(item.file), { selection: new vscode.Range(line, 0, line, 0), preview: false });
				}
				break;
			case 'keepAll':
				await vscode.commands.executeCommand('agentecode.review.keepAll');
				break;
			case 'revertAll':
				await vscode.commands.executeCommand('agentecode.review.revertAll');
				break;
			case 'chooseBase':
				await vscode.commands.executeCommand('agentecode.review.chooseBase');
				break;
			case 'chooseSession':
				await vscode.commands.executeCommand('agentecode.review.chooseSession');
				break;
			case 'toggleReviewed':
				await vscode.commands.executeCommand('agentecode.review.toggleReviewed');
				break;
		}
	}

	context.subscriptions.push(vscode.window.registerWebviewViewProvider(PANEL_ID, {
		resolveWebviewView(webviewView) {
			panelView = webviewView;
			webviewView.webview.options = { enableScripts: true };
			const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
			webviewView.webview.html = renderPanelHtml({ nonce, cspSource: webviewView.webview.cspSource });
			webviewView.webview.onDidReceiveMessage(message => void handlePanelMessage(message));
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible) {
					void reload();
				}
			});
			webviewView.onDidDispose(() => {
				if (panelView === webviewView) {
					panelView = undefined;
				}
			});
		}
	}, { webviewOptions: { retainContextWhenHidden: true } }));

	// --- Mudancas feitas por terminal: fotos do projeto no comeco de cada pedido ---
	const snapshotsFile = path.join(context.globalStorageUri.fsPath, 'terminal-snapshots.json');
	const MAX_SNAP_SESSIONS = 40;
	const MAX_SNAPS_PER_SESSION = 300;
	/** @type {{ sessions: Record<string, { root: string, snaps: { uuid: string, ts: number, tree: string }[] }> }} */
	let snapshotDb = { sessions: {} };
	try {
		snapshotDb = JSON.parse(fs.readFileSync(snapshotsFile, 'utf8'));
	} catch {
		// primeira vez
	}
	if (!snapshotDb.sessions) {
		snapshotDb.sessions = {};
	}
	let saveTimer;
	const saveSnapshots = () => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(async () => {
			const ids = Object.keys(snapshotDb.sessions);
			if (ids.length > MAX_SNAP_SESSIONS) {
				const last = id => snapshotDb.sessions[id].snaps.at(-1)?.ts ?? 0;
				for (const id of ids.sort((a, b) => last(a) - last(b)).slice(0, ids.length - MAX_SNAP_SESSIONS)) {
					delete snapshotDb.sessions[id];
				}
			}
			try {
				await fs.promises.mkdir(path.dirname(snapshotsFile), { recursive: true });
				await fs.promises.writeFile(`${snapshotsFile}.tmp`, JSON.stringify(snapshotDb), 'utf8');
				await fs.promises.rename(`${snapshotsFile}.tmp`, snapshotsFile);
			} catch {
				// as fotos sao um reforco: sem salvar, o modo aproximado cobre
			}
		}, 500);
	};
	const terminalEnabled = () => vscode.workspace.getConfiguration('agentecode.review').get('terminalChanges', true);

	let snapshotQueue = Promise.resolve();
	const takeSnapshot = (root, sessionId, prompt) => {
		snapshotQueue = snapshotQueue.then(async () => {
			try {
				const tree = await gs.snapshotTree(root);
				const entry = snapshotDb.sessions[sessionId] ?? (snapshotDb.sessions[sessionId] = { root, snaps: [] });
				entry.root = root;
				entry.snaps.push({ uuid: prompt.uuid, ts: Date.now(), tree });
				if (entry.snaps.length > MAX_SNAPS_PER_SESSION) {
					entry.snaps.splice(0, entry.snaps.length - MAX_SNAPS_PER_SESSION);
				}
				saveSnapshots();
			} catch (error) {
				console.warn('AgenteCode: não foi possível tirar a foto do projeto', error && error.message);
			}
		});
		return snapshotQueue;
	};

	/** @type {TurnWatcher[]} */
	const turnWatchers = [];
	async function startTurnWatchers() {
		if (!terminalEnabled()) {
			return;
		}
		const projectsRoot = path.join(claudeConfigDir(), 'projects');
		let dirs = [];
		try {
			dirs = await fs.promises.readdir(projectsRoot);
		} catch {
			// ainda sem conversas
		}
		for (const folder of (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)) {
			const root = await gs.repoRoot(folder);
			if (!root) {
				continue;
			}
			const slug = projectSlug(folder);
			const dir = path.join(projectsRoot, dirs.find(d => d.toLowerCase() === slug.toLowerCase()) ?? slug);
			const watcher = new TurnWatcher(dir, (sessionId, prompt) => {
				if (terminalEnabled()) {
					void takeSnapshot(root, sessionId, prompt);
				}
			});
			turnWatchers.push(watcher);
			await watcher.start();
		}
	}
	void startTurnWatchers();
	context.subscriptions.push({ dispose: () => { turnWatchers.forEach(w => w.dispose()); clearTimeout(saveTimer); } });

	/** Horario da conversa (primeira mensagem ate a ultima gravacao), para o modo aproximado. */
	async function sessionWindow(target) {
		let from = Date.now();
		let to = Date.now();
		try {
			const stat = await fs.promises.stat(target.file);
			to = stat.mtimeMs;
			from = stat.birthtimeMs || stat.mtimeMs;
			const handle = await fs.promises.open(target.file, 'r');
			try {
				const buffer = Buffer.alloc(Math.min(65536, stat.size));
				await handle.read(buffer, 0, buffer.length, 0);
				for (const line of buffer.toString('utf8').split('\n')) {
					const time = line ? Date.parse((() => { try { return JSON.parse(line).timestamp; } catch { return undefined; } })()) : NaN;
					if (!Number.isNaN(time)) {
						from = time;
						break;
					}
				}
			} finally {
				await handle.close();
			}
		} catch {
			// usa o padrao
		}
		return { from, to };
	}

	/** @type {{ key: string, at: number, result: any } | undefined} */
	let terminalCache;
	const TERMINAL_CACHE_MS = 30000;
	const repoRootCache = new Map();

	/**
	 * Arquivos alterados fora do registro do Claude Code (terminal e outras ferramentas), sem repetir os que o registro ja tem.
	 * @param {any[]} internalItems
	 * @param {boolean} useCache
	 */
	async function terminalItems(internalItems, useCache) {
		const none = { mode: 'none', truncated: false, items: [] };
		const cwd = session.cwd || roots()[0];
		if (!cwd) {
			return none;
		}
		let root = repoRootCache.get(cwd);
		if (root === undefined) {
			root = await gs.repoRoot(cwd);
			repoRootCache.set(cwd, root);
		}
		if (!root) {
			return none;
		}
		const entry = snapshotDb.sessions[session.id];
		const snap = entry ? (base ? entry.snaps.find(s => s.uuid === base.messageId) : entry.snaps[0]) : undefined;
		if (base && !snap) {
			return none; // sem foto deste pedido, so o registro do agente vale
		}
		const key = `${session.id}|${snap ? snap.tree : 'aprox'}`;
		let result;
		if (useCache && terminalCache && terminalCache.key === key && Date.now() - terminalCache.at < TERMINAL_CACHE_MS) {
			result = terminalCache.result;
		} else {
			result = await computeTerminalChanges({ repoRoot: root, baseTree: snap?.tree, beforeDir, window: await sessionWindow(session) });
			terminalCache = { key, at: Date.now(), result };
		}
		const known = new Set(internalItems.map(i => keyOf(i.file)));
		return { ...result, items: result.items.filter(i => !known.has(keyOf(i.file)) && isInsideAny(i.file, roots())) };
	}

	/**
	 * Tira da lista o que ja foi commitado: so fica o que ainda esta pendente no git (como a tela de controle de codigo-fonte).
	 * Arquivos fora de um repositorio git continuam na lista.
	 * @param {any[]} items
	 */
	async function dropCommitted(items) {
		/** @type {Map<string, { file: string, rel: string }[]>} */
		const byRoot = new Map();
		for (const item of items) {
			const dir = path.dirname(item.file);
			let root = repoRootCache.get(dir);
			if (root === undefined) {
				root = await gs.repoRoot(dir);
				repoRootCache.set(dir, root);
			}
			if (root) {
				const list = byRoot.get(root) ?? [];
				list.push({ file: item.file, rel: path.relative(root, item.file).split(path.sep).join('/') });
				byRoot.set(root, list);
			}
		}
		const done = new Set();
		for (const [root, list] of byRoot) {
			try {
				const resolved = await gs.committedPaths(root, list.map(e => e.rel));
				list.filter(e => resolved.has(e.rel)).forEach(e => done.add(e.file));
			} catch (error) {
				console.warn('AgenteCode: não foi possível comparar com o último commit', error && error.message);
			}
		}
		return items.filter(item => !done.has(item.file));
	}

	const terminalNote = mode => (mode === 'exact'
		? 'Inclui o que foi alterado por comandos de terminal (comparado com a foto do projeto no começo do pedido).'
		: mode === 'approx'
			? 'As mudanças por terminal são aproximadas: comparadas com o último commit anterior à conversa, só dos arquivos mexidos no horário dela.'
			: 'Sem repositório git: o que foi feito por comandos de terminal não aparece aqui.');

	/** Recalcula as alteracoes e atualiza arvore, painel de codigo-fonte, margem do editor e Explorer. */
	async function reload(useCache = false) {
		if (loading) {
			return loading;
		}
		loading = (async () => {
			try {
				if (!session || !pinned) {
					const found = await chooseDefaultSession();
					if (found && session && found.id !== session.id) {
						base = undefined;
					}
					session = found ?? (pinned ? session : undefined);
				}
				const previous = [...pendingByKey.values()].map(i => i.file);
				if (!session) {
					review = undefined;
					pendingByKey = new Map();
					view.message = 'Nenhuma conversa do agente encontrada para esta pasta.';
				} else {
					const computed = await computeReview(session, roots(), { baseMessageId: base?.messageId });
					let terminal = { mode: 'none', truncated: false, items: [] };
					if (terminalEnabled()) {
						try {
							terminal = await terminalItems(computed.items, useCache);
						} catch (error) {
							console.warn('AgenteCode: mudanças por terminal indisponíveis', error && error.message);
						}
					}
					const allItems = await dropCommitted([...computed.items, ...terminal.items].sort((a, b) => a.file.localeCompare(b.file)));
					const { pending, hidden: hiddenCount } = await splitReviewed(allItems, reviewedMap());
					review = { ...computed, items: allItems, all: allItems, pending, terminalMode: terminal.mode, terminalTruncated: terminal.truncated };
					hidden = hiddenCount;
					pendingByKey = new Map(pending.map(i => [keyOf(i.file), i]));

					const notes = [`Conversa: ${session.title ?? session.id}`, `Comparando com: ${base ? `antes de "${base.prompt.slice(0, 40)}"` : 'o início da conversa'}`];
					if (!computed.firstMessageId && !allItems.length) {
						notes.push('Esta conversa ainda não alterou arquivos.');
					} else if (!pending.length) {
						notes.push(hidden ? `Tudo revisado (${hidden}).` : 'Nenhuma diferença.');
					}
					if (hidden && pending.length) {
						notes.push(`${hidden} já revisado(s) oculto(s).`);
					}
					notes.push(terminalNote(terminal.mode));
					view.message = notes.join(' · ');
				}

				const pendingNow = review ? review.pending : [];
				const sum = key => pendingNow.reduce((total, item) => total + (item[key] ?? 0), 0);
				view.description = pendingNow.length ? `${pendingNow.length} arquivo(s) +${sum('added')} −${sum('removed')}` : undefined;
				view.badge = pendingNow.length ? { value: pendingNow.length, tooltip: `${pendingNow.length} arquivo(s) a revisar` } : undefined;
				scm.count = pendingNow.length;
				scmGroup.resourceStates = pendingNow.map(item => ({
					resourceUri: vscode.Uri.file(item.file),
					decorations: {
						tooltip: `${STATUS[item.status].text}${item.added === null ? '' : ` +${item.added} −${item.removed}`}`,
						strikeThrough: item.status === 'deleted'
					},
					command: { command: 'agentecode.review.open', title: 'Ver diferença', arguments: [item] },
					contextValue: 'reviewFile'
				}));
				decorationEmitter.fire([...previous, ...pendingNow.map(i => i.file)].map(f => vscode.Uri.file(f)));
				treeEmitter.fire(undefined);
				lensEmitter.fire();
				void postPanel();
			} catch (error) {
				review = undefined;
				view.message = `Não foi possível ler as alterações: ${error && error.message ? error.message : error}`;
			} finally {
				loading = undefined;
			}
		})();
		return loading;
	}

	const markReviewed = async files => {
		const map = { ...reviewedMap() };
		for (const file of files) {
			map[file] = await fingerprint(file);
		}
		await context.workspaceState.update(REVIEWED_KEY, map);
		await reload();
	};

	const restoreFiles = async (items, label) => {
		const changes = items.map(i => ({ file: i.file, action: i.status === 'added' ? 'delete' : i.status === 'deleted' ? 'recreate' : 'restore', backup: i.backup }));
		const dirty = changes.filter(c => vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && isInsideAny(d.uri.fsPath, [c.file])));
		if (dirty.length) {
			void vscode.window.showWarningMessage(`Salve ou descarte as alterações abertas no editor antes de voltar: ${dirty.map(d => path.basename(d.file)).join(', ')}.`);
			return;
		}
		const names = items.slice(0, 6).map(i => `• ${path.basename(i.file)} (${STATUS[i.status].text})`).join('\n') + (items.length > 6 ? `\n… e mais ${items.length - 6}` : '');
		const confirm = await vscode.window.showWarningMessage(
			items.length === 1 ? 'Voltar este arquivo para o estado de antes?' : `Voltar ${items.length} arquivos para o estado de antes?`,
			{ modal: true, detail: `${names}\n\nSe você mesmo editou o arquivo depois do agente, essas edições também voltam. O estado atual fica guardado e dá para desfazer em "AgenteCode: Desfazer a última volta de arquivos".` },
			'Voltar'
		);
		if (confirm !== 'Voltar') {
			return;
		}
		await saveUndoPoint(context, label, changes);
		let failed = 0;
		for (const change of changes) {
			try {
				await applyChange(change);
			} catch (error) {
				failed++;
				console.error(`AgenteCode: falha ao voltar ${change.file}`, error);
			}
		}
		await reload();
		const choice = await vscode.window.showInformationMessage(
			failed ? `${changes.length - failed} arquivo(s) voltaram; ${failed} falharam (veja o console do desenvolvedor).` : `${changes.length} arquivo(s) voltaram.`,
			'Desfazer'
		);
		if (choice === 'Desfazer') {
			await undoLastRewind(context);
			await reload();
		}
	};

	/** Aceita itens da arvore (com `file`) e estados do painel de codigo-fonte (com `resourceUri`). */
	const asItem = e => (e?.file ? e : e?.resourceUri ? pendingByKey.get(keyOf(e.resourceUri.fsPath)) : undefined);
	const targetsOf = (item, selection) => {
		const chosen = selection?.length ? selection : item ? [item] : view.selection;
		return chosen.map(asItem).filter(Boolean);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('agentecode.review.refresh', () => reload()),

		vscode.commands.registerCommand('agentecode.review.open', async raw => {
			const item = asItem(raw);
			if (!item || !session) {
				return;
			}
			const uri = vscode.Uri.file(item.file);
			if (item.status === 'modified') {
				await vscode.commands.executeCommand('vscode.diff', backupUri(session.id, item.file, item.backup, item.source === 'terminal'), uri, `${path.basename(item.file)} (antes ↔ agora)`, { preview: true });
			} else if (item.status === 'added') {
				await vscode.commands.executeCommand('vscode.diff', backupUri(session.id, item.file, undefined), uri, `${path.basename(item.file)} (novo)`, { preview: true });
			} else {
				await vscode.commands.executeCommand('vscode.open', backupUri(session.id, item.file, item.backup, item.source === 'terminal'), { preview: true }, `${path.basename(item.file)} (excluído)`);
			}
		}),

		vscode.commands.registerCommand('agentecode.review.keep', async (item, selection) => {
			const targets = targetsOf(item, selection);
			if (targets.length) {
				await markReviewed(targets.map(t => t.file));
			}
		}),

		vscode.commands.registerCommand('agentecode.review.keepHunkAtCursor', async () => {
			const target = await hunkAtCursor();
			if (target) {
				await vscode.commands.executeCommand('agentecode.review.keepHunk', target.uri, target.key);
			} else {
				void vscode.window.showInformationMessage('Coloque o cursor dentro de um trecho alterado pelo agente.');
			}
		}),

		vscode.commands.registerCommand('agentecode.review.undoHunkAtCursor', async () => {
			const target = await hunkAtCursor();
			if (target) {
				await vscode.commands.executeCommand('agentecode.review.undoHunk', target.uri, target.key);
			} else {
				void vscode.window.showInformationMessage('Coloque o cursor dentro de um trecho alterado pelo agente.');
			}
		}),

		vscode.commands.registerCommand('agentecode.review.keepHunk', async (rawUri, key) => {
			const uri = asUri(rawUri);
			const item = pendingByKey.get(keyOf(uri.fsPath));
			if (!item) {
				return;
			}
			const map = { ...keptMap() };
			map[item.file] = [...new Set([...(map[item.file] ?? []), key])];
			await context.workspaceState.update(KEPT_HUNKS_KEY, map);
			const document = await vscode.workspace.openTextDocument(uri);
			// Sem trechos pendentes, o arquivo inteiro conta como revisado
			if (!(await pendingHunks(item, document.getText())).length) {
				await markReviewed([item.file]);
			} else {
				lensEmitter.fire();
			}
		}),

		vscode.commands.registerCommand('agentecode.review.undoHunk', async (rawUri, key) => {
			const uri = asUri(rawUri);
			const item = pendingByKey.get(keyOf(uri.fsPath));
			if (!item) {
				return;
			}
			const document = await vscode.workspace.openTextDocument(uri);
			const current = document.getText();
			const hunk = computeHunks(await readBackupText(item), current).find(h => h.key === key);
			if (!hunk) {
				void vscode.window.showInformationMessage('Este trecho mudou desde que a lista foi calculada. Atualize e tente de novo.');
				lensEmitter.fire();
				return;
			}
			// Edicao minima: troca so o pedaco que difere, para preservar cursor, dobras e historico de desfazer (Ctrl+Z)
			const reverted = revertHunkInText(current, hunk);
			let start = 0;
			while (start < current.length && start < reverted.length && current[start] === reverted[start]) {
				start++;
			}
			let tail = 0;
			while (tail < current.length - start && tail < reverted.length - start && current[current.length - 1 - tail] === reverted[reverted.length - 1 - tail]) {
				tail++;
			}
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(current.length - tail)), reverted.slice(start, reverted.length - tail));
			const wasDirty = document.isDirty;
			await vscode.workspace.applyEdit(edit);
			if (!wasDirty) {
				await document.save();
			}
			await reload();
		}),

		vscode.commands.registerCommand('agentecode.review.keepAll', async () => {
			if (review?.pending.length) {
				await markReviewed(review.pending.map(p => p.file));
			}
		}),

		vscode.commands.registerCommand('agentecode.review.revert', async (item, selection) => {
			const targets = targetsOf(item, selection);
			if (targets.length) {
				await restoreFiles(targets, `revisão: ${targets.length} arquivo(s)`);
			}
		}),

		vscode.commands.registerCommand('agentecode.review.revertAll', async () => {
			if (session && review?.pending.some(i => i.source === 'terminal')) {
				await restoreFiles(review.pending, `revisão: ${review.pending.length} arquivo(s)`);
			} else if (session && review?.firstMessageId) {
				await rewindToCheckpoint(context, session, { messageId: review.firstMessageId, prompt: base ? base.prompt : 'o início da conversa' });
				await reload();
			}
		}),

		vscode.commands.registerCommand('agentecode.review.toggleReviewed', async () => {
			showReviewed = !showReviewed;
			void vscode.window.showInformationMessage(showReviewed ? 'Mostrando também os arquivos já revisados na lista lateral.' : 'Ocultando os arquivos já revisados.');
			treeEmitter.fire(undefined);
			void postPanel();
		}),

		vscode.commands.registerCommand('agentecode.review.clearReviewed', async () => {
			await context.workspaceState.update(REVIEWED_KEY, {});
			await reload();
		}),

		vscode.commands.registerCommand('agentecode.review.chooseSession', async () => {
			const all = await listSessions((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath), 40);
			const picked = await vscode.window.showQuickPick(
				all.map(s => ({ label: s.title, description: new Date(s.mtime).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }), session: s })),
				{ title: 'Revisar alterações de qual conversa?', placeHolder: 'Escolha a conversa do agente' }
			);
			if (picked) {
				session = picked.session;
				pinned = true;
				base = undefined;
				await reload();
			}
		}),

		vscode.commands.registerCommand('agentecode.review.chooseBase', async () => {
			if (!session) {
				return;
			}
			const turns = await listBases(session.file);
			const items = [
				{ label: '$(history) Início da conversa', description: base ? '' : 'atual', turn: undefined },
				...turns.slice(0, 60).map((t, index) => ({
					label: index === 0 ? '$(debug-step-back) Antes da última resposta' : `Antes de: ${t.prompt.slice(0, 70)}`,
					description: t.timestamp ? new Date(t.timestamp).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '',
					detail: index === 0 ? t.prompt.slice(0, 100) : undefined,
					turn: t
				}))
			];
			const picked = await vscode.window.showQuickPick(items, { title: 'Comparar as alterações com...', placeHolder: 'O que o agente mudou desde quando?' });
			if (picked) {
				base = picked.turn ? { messageId: picked.turn.messageId, prompt: picked.turn.prompt } : undefined;
				await reload();
			}
		}),

		// Atalho a partir da lista de sessoes
		vscode.commands.registerCommand('agentecode.review.forSession', item => {
			if (item?.kind === 'session') {
				session = { file: item.file, id: item.id, cwd: item.cwd, title: item.title };
				pinned = true;
				base = undefined;
				void reload();
				void vscode.commands.executeCommand(vscode.workspace.getConfiguration('agentecode.review').get('panel', 'webview') === 'tree' ? `${VIEW_ID}.focus` : `${PANEL_ID}.focus`);
			}
		}),

		vscode.window.onDidChangeWindowState(state => {
			if (state.focused) {
				void reload(true);
			}
		}),
		view.onDidChangeVisibility(e => {
			if (e.visible) {
				void reload(true);
			}
		})
	);

	// Mantem margem, Explorer e painel em dia enquanto o agente trabalha (so com a janela em foco)
	const timer = setInterval(() => {
		if (vscode.window.state.focused) {
			void reload(true);
		}
	}, REFRESH_MS);
	const first = setTimeout(() => void reload(), 3000);
	context.subscriptions.push({ dispose: () => { clearInterval(timer); clearTimeout(first); } });
}

module.exports = { registerReviewView };
