/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { computeReview, splitReviewed, fingerprint } = require('./review');
const { isInsideAny, BACKUP_NAME } = require('./checkpoints');
const { listSessions, fileHistoryDir } = require('./sessionStore');
const { applyChange } = require('./rewindPlan');
const { rewindToCheckpoint, undoLastRewind, saveUndoPoint } = require('./rewind');

const VIEW_ID = 'agentecode.review';
const SCHEME = 'agentecode-review';
const REVIEWED_KEY = 'agentecode.review.reviewed';
const REFRESH_MS = 15000;

const STATUS = {
	modified: { text: 'modificado', icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
	added: { text: 'novo', icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
	deleted: { text: 'excluído', icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground' }
};

/** Mostra o conteudo da copia (checkpoint) com o nome do arquivo original, para ter realce de sintaxe no diff. */
class BackupContentProvider {
	provideTextDocumentContent(uri) {
		const { session, backup } = JSON.parse(uri.query);
		if (!BACKUP_NAME.test(backup) || !/^[0-9a-f-]+$/i.test(session)) {
			return '';
		}
		return fs.promises.readFile(path.join(fileHistoryDir(session), backup), 'utf8').catch(() => '');
	}
}

function backupUri(sessionId, file, backup) {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${path.basename(file)}`, query: JSON.stringify({ session: sessionId, backup: path.basename(backup) }) });
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
	let loading;

	const emitter = new vscode.EventEmitter();
	const roots = () => {
		const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
		return folders.length ? folders : session?.cwd ? [session.cwd] : [];
	};
	const reviewedMap = () => context.workspaceState.get(REVIEWED_KEY, {});

	const view = vscode.window.createTreeView(VIEW_ID, {
		treeDataProvider: {
			onDidChangeTreeData: emitter.event,
			getChildren: async element => {
				if (element) {
					return [];
				}
				await load();
				return review ? (showReviewed ? review.all : review.pending) : [];
			},
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
	context.subscriptions.push(view, emitter);
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, new BackupContentProvider()));

	const refresh = () => emitter.fire(undefined);

	async function chooseDefaultSession() {
		const all = await listSessions((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath), 30);
		return all.find(s => s.size > 0);
	}

	async function load() {
		if (loading) {
			return loading;
		}
		loading = (async () => {
			try {
				if (!session || !pinned) {
					session = (await chooseDefaultSession()) ?? (pinned ? session : undefined);
				}
				if (!session) {
					review = undefined;
					view.message = 'Nenhuma conversa do agente encontrada para esta pasta.';
					return;
				}
				const computed = await computeReview(session, roots());
				const { pending, hidden: hiddenCount } = await splitReviewed(computed.items, reviewedMap());
				review = { ...computed, all: computed.items, pending };
				hidden = hiddenCount;
				const notes = [`Conversa: ${session.title ?? session.id}`];
				if (!computed.firstMessageId) {
					notes.push('Esta conversa ainda não alterou arquivos.');
				} else if (!pending.length) {
					notes.push(hidden ? `Tudo revisado (${hidden}).` : 'Nenhuma diferença: os arquivos estão como antes da conversa.');
				}
				if (hidden && pending.length) {
					notes.push(`${hidden} já revisado(s) oculto(s).`);
				}
				notes.push('O que foi feito por comandos de terminal não aparece aqui.');
				view.message = notes.join(' · ');
				view.badge = pending.length ? { value: pending.length, tooltip: `${pending.length} arquivo(s) a revisar` } : undefined;
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
		refresh();
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
			items.length === 1 ? 'Voltar este arquivo para antes da conversa?' : `Voltar ${items.length} arquivos para antes da conversa?`,
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
		refresh();
		const choice = await vscode.window.showInformationMessage(
			failed ? `${changes.length - failed} arquivo(s) voltaram; ${failed} falharam (veja o console do desenvolvedor).` : `${changes.length} arquivo(s) voltaram para antes da conversa.`,
			'Desfazer'
		);
		if (choice === 'Desfazer') {
			await undoLastRewind(context);
			refresh();
		}
	};

	const targetsOf = (item, selection) => (selection?.length ? selection : item ? [item] : view.selection).filter(e => e?.file);

	context.subscriptions.push(
		vscode.commands.registerCommand('agentecode.review.refresh', () => refresh()),

		vscode.commands.registerCommand('agentecode.review.open', async item => {
			if (!item || !session) {
				return;
			}
			const uri = vscode.Uri.file(item.file);
			if (item.status === 'modified') {
				await vscode.commands.executeCommand('vscode.diff', backupUri(session.id, item.file, item.backup), uri, `${path.basename(item.file)} (antes da conversa ↔ agora)`, { preview: true });
			} else if (item.status === 'added') {
				await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
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
				await rewindToCheckpoint(context, session, { messageId: review.firstMessageId, prompt: 'o início da conversa' });
				refresh();
			}
		}),

		vscode.commands.registerCommand('agentecode.review.toggleReviewed', async () => {
			showReviewed = !showReviewed;
			void vscode.window.showInformationMessage(showReviewed ? 'Mostrando também os arquivos já revisados.' : 'Ocultando os arquivos já revisados.');
			refresh();
		}),

		vscode.commands.registerCommand('agentecode.review.clearReviewed', async () => {
			await context.workspaceState.update(REVIEWED_KEY, {});
			refresh();
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
				refresh();
			}
		}),

		// Atalho a partir da lista de sessoes
		vscode.commands.registerCommand('agentecode.review.forSession', item => {
			if (item?.kind === 'session') {
				session = { file: item.file, id: item.id, cwd: item.cwd, title: item.title };
				pinned = true;
				refresh();
				void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
			}
		}),

		vscode.window.onDidChangeWindowState(state => {
			if (state.focused) {
				refresh();
			}
		}),
		view.onDidChangeVisibility(e => {
			if (e.visible) {
				refresh();
			}
		})
	);

	// Enquanto a conversa esta rodando, atualiza sozinho (so com o painel visivel)
	const timer = setInterval(() => {
		if (view.visible) {
			refresh();
		}
	}, REFRESH_MS);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

module.exports = { registerReviewView };
