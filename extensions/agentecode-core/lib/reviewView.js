/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { computeReview, splitReviewed, fingerprint, listBases } = require('./review');
const { isInsideAny, BACKUP_NAME } = require('./checkpoints');
const { listSessions, fileHistoryDir } = require('./sessionStore');
const { applyChange } = require('./rewindPlan');
const { rewindToCheckpoint, undoLastRewind, saveUndoPoint } = require('./rewind');

const VIEW_ID = 'agentecode.review';
const SCM_ID = 'agentecode-review';
const SCHEME = 'agentecode-review';
const REVIEWED_KEY = 'agentecode.review.reviewed';
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
	provideTextDocumentContent(uri) {
		const { session, backup } = JSON.parse(uri.query);
		if (backup === EMPTY) {
			return '';
		}
		if (!BACKUP_NAME.test(backup) || !/^[0-9a-f-]+$/i.test(session)) {
			return '';
		}
		return fs.promises.readFile(path.join(fileHistoryDir(session), backup), 'utf8').catch(() => '');
	}
}

function backupUri(sessionId, file, backup) {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${path.basename(file)}`, query: JSON.stringify({ session: sessionId, backup: backup ? path.basename(backup) : EMPTY }) });
}

/** @param {vscode.ExtensionContext} context */
function registerReviewView(context) {
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
				item.description = `${relDir === '.' ? '' : `${relDir}  `}${info.text}${counts}`;
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
			return item && item.status !== 'deleted' && session ? backupUri(session.id, item.file, item.backup) : undefined;
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

	context.subscriptions.push(
		view, treeEmitter, decorationEmitter, scm, scmGroup,
		vscode.window.registerFileDecorationProvider(decorations),
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, new BackupContentProvider())
	);

	async function chooseDefaultSession() {
		const all = await listSessions((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath), 30);
		return all.find(s => s.size > 0);
	}

	/** Recalcula as alteracoes e atualiza arvore, painel de codigo-fonte, margem do editor e Explorer. */
	async function reload() {
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
					const { pending, hidden: hiddenCount } = await splitReviewed(computed.items, reviewedMap());
					review = { ...computed, all: computed.items, pending };
					hidden = hiddenCount;
					pendingByKey = new Map(pending.map(i => [keyOf(i.file), i]));

					const notes = [`Conversa: ${session.title ?? session.id}`, `Comparando com: ${base ? `antes de "${base.prompt.slice(0, 40)}"` : 'o início da conversa'}`];
					if (!computed.firstMessageId) {
						notes.push('Esta conversa ainda não alterou arquivos.');
					} else if (!pending.length) {
						notes.push(hidden ? `Tudo revisado (${hidden}).` : 'Nenhuma diferença.');
					}
					if (hidden && pending.length) {
						notes.push(`${hidden} já revisado(s) oculto(s).`);
					}
					notes.push('O que foi feito por comandos de terminal não aparece aqui.');
					view.message = notes.join(' · ');
				}

				const pendingNow = review ? review.pending : [];
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
				await vscode.commands.executeCommand('vscode.diff', backupUri(session.id, item.file, item.backup), uri, `${path.basename(item.file)} (antes ↔ agora)`, { preview: true });
			} else if (item.status === 'added') {
				await vscode.commands.executeCommand('vscode.diff', backupUri(session.id, item.file, undefined), uri, `${path.basename(item.file)} (novo)`, { preview: true });
			} else {
				await vscode.commands.executeCommand('vscode.open', backupUri(session.id, item.file, item.backup), { preview: true }, `${path.basename(item.file)} (excluído pelo agente)`);
			}
		}),

		vscode.commands.registerCommand('agentecode.review.keep', async (item, selection) => {
			const targets = targetsOf(item, selection);
			if (targets.length) {
				await markReviewed(targets.map(t => t.file));
			}
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
			if (session && review?.firstMessageId) {
				await rewindToCheckpoint(context, session, { messageId: review.firstMessageId, prompt: base ? base.prompt : 'o início da conversa' });
				await reload();
			}
		}),

		vscode.commands.registerCommand('agentecode.review.toggleReviewed', async () => {
			showReviewed = !showReviewed;
			void vscode.window.showInformationMessage(showReviewed ? 'Mostrando também os arquivos já revisados na lista lateral.' : 'Ocultando os arquivos já revisados.');
			treeEmitter.fire(undefined);
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
				void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
			}
		}),

		vscode.window.onDidChangeWindowState(state => {
			if (state.focused) {
				void reload();
			}
		}),
		view.onDidChangeVisibility(e => {
			if (e.visible) {
				void reload();
			}
		})
	);

	// Mantem margem, Explorer e painel em dia enquanto o agente trabalha (so com a janela em foco)
	const timer = setInterval(() => {
		if (vscode.window.state.focused) {
			void reload();
		}
	}, REFRESH_MS);
	const first = setTimeout(() => void reload(), 3000);
	context.subscriptions.push({ dispose: () => { clearInterval(timer); clearTimeout(first); } });
}

module.exports = { registerReviewView };
