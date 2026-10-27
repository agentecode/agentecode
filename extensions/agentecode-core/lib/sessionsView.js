/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const { readEntries } = require('./sessionMarkdown');
const { listCheckpoints, planRewind } = require('./checkpoints');
const { listSessions, isActiveSession, sessionMatches, sessionArtifacts } = require('./sessionStore');
const { rewindToCheckpoint, undoLastRewind } = require('./rewind');
const { t, getLanguage } = require('./i18n');

const VIEW_ID = 'agentecode.sessions';
const SEARCH_CONTEXT = 'agentecode.sessions.searching';

/** Reduz um prompt do usuario ao que o painel usa, para nao guardar imagens em base64 na memoria. */
function slimUser(entry) {
	const content = entry.message?.content;
	let text = '';
	if (typeof content === 'string') {
		text = content;
	} else if (Array.isArray(content) && !content.some(b => b?.type === 'tool_result')) {
		text = content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
	}
	return { type: 'user', uuid: entry.uuid, isMeta: entry.isMeta, isSidechain: entry.isSidechain, timestamp: entry.timestamp, message: { content: text } };
}

/** Checkpoints de uma sessao que tem arquivos rastreados (so esses podem voltar algo). */
async function loadCheckpoints(file) {
	const entries = [];
	await readEntries(file, entry => entries.push(entry.type === 'user' ? slimUser(entry) : entry), line => line.includes('"type":"user"') || line.includes('"type":"file-history-'));
	return listCheckpoints(entries).filter(c => planRewind(entries, c.messageId)?.length);
}

function formatDate(value) {
	const date = new Date(value);
	return isNaN(date.getTime()) ? '' : date.toLocaleString(getLanguage() === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
}

function formatSize(bytes) {
	return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Abre uma sessao no Claude Code. Por padrao, no painel lateral integrado.
 *
 * O Claude Code so abre no painel lateral quando `claudeCode.preferredLocation` e "sidebar" E o comando
 * recebe `{ programmatic: 'honor-preferred-location' }` como 7o argumento (sem isso ele sempre abre uma aba
 * do editor e ainda troca a preferencia para "panel"). Esse argumento e interno da extensao dele.
 * @param {string} sessionId
 */
async function resumeSession(sessionId) {
	const where = vscode.workspace.getConfiguration('agentecode.sessions').get('resumeLocation', 'sidebar');
	if (where === 'editor') {
		await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
		return;
	}
	const claude = vscode.workspace.getConfiguration('claudeCode');
	if (claude.get('preferredLocation') !== 'sidebar') {
		await claude.update('preferredLocation', 'sidebar', vscode.ConfigurationTarget.Global);
	}
	await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' });
}

class SessionsProvider {
	constructor() {
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		/** @type {string | undefined} */
		this.query = undefined;
		/** @type {Set<string> | undefined} arquivos de sessao que contem a busca */
		this.matches = undefined;
		/** @type {Map<string, Promise<any[]>>} */
		this.checkpointCache = new Map();
		/** @type {any[]} ultima lista carregada */
		this.sessions = [];
	}

	refresh() {
		this._onDidChangeTreeData.fire(undefined);
	}

	get folders() {
		return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
	}

	async getChildren(element) {
		if (!element) {
			const all = await listSessions(this.folders);
			this.sessions = this.matches ? all.filter(s => this.matches.has(s.file)) : all;
			return this.sessions.map(s => ({ kind: 'session', ...s }));
		}
		if (element.kind === 'session') {
			const key = `${element.file}|${element.mtime}|${element.size}`;
			let pending = this.checkpointCache.get(key);
			if (!pending) {
				pending = loadCheckpoints(element.file).catch(() => []);
				this.checkpointCache.set(key, pending);
			}
			return (await pending).map(c => ({ kind: 'checkpoint', session: element, ...c }));
		}
		return [];
	}

	getTreeItem(element) {
		if (element.kind === 'session') {
			const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.Collapsed);
			item.id = `session:${element.id}`;
			item.description = `${formatDate(element.mtime)} · ${formatSize(element.size)}`;
			item.iconPath = new vscode.ThemeIcon('comment-discussion');
			item.contextValue = 'session';
			const tip = new vscode.MarkdownString(undefined, true);
			tip.appendText(`${element.title}\n\n${t('Session: {0}', element.id)}\n${t('Project: {0}', element.cwd ?? '-')}\n${t('File: {0}', element.file)}`);
			item.tooltip = tip;
			return item;
		}
		const item = new vscode.TreeItem(element.prompt, vscode.TreeItemCollapsibleState.None);
		item.id = `checkpoint:${element.session.id}:${element.messageId}`;
		item.description = formatDate(element.timestamp);
		item.iconPath = new vscode.ThemeIcon('discard');
		item.contextValue = 'checkpoint';
		item.tooltip = `${element.prompt}\n\n${t('Click the button to restore the files to before this response.')}`;
		return item;
	}
}

/** @param {vscode.ExtensionContext} context */
function registerSessionsView(context) {
	const provider = new SessionsProvider();
	const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, canSelectMany: true, showCollapseAll: true });
	context.subscriptions.push(view);

	const setSearch = async (query) => {
		provider.query = query;
		provider.matches = undefined;
		void vscode.commands.executeCommand('setContext', SEARCH_CONTEXT, !!query);
		view.message = undefined;

		if (query) {
			const matches = new Set();
			const all = await listSessions(provider.folders);
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Searching for "{0}" in the sessions…', query), cancellable: true }, async (_progress, token) => {
				for (const session of all) {
					if (token.isCancellationRequested) {
						break;
					}
					if (await sessionMatches(session.file, query, token)) {
						matches.add(session.file);
					}
				}
			});
			provider.matches = matches;
			view.message = matches.size
				? t('Search: "{0}" — {1} session(s)', query, matches.size)
				: t('No session contains "{0}".', query);
		}
		provider.refresh();
	};

	/** Sessoes selecionadas na arvore, ou o item em que o botao foi clicado. */
	const sessionsFrom = (item, selection) => {
		const chosen = selection?.length ? selection : item ? [item] : view.selection;
		return chosen.filter(e => e?.kind === 'session');
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('agentecode.sessions.refresh', () => provider.refresh()),

		vscode.commands.registerCommand('agentecode.sessions.search', async () => {
			const query = await vscode.window.showInputBox({ title: t('Search the agent sessions'), prompt: t('Searches the text of the conversations (case-insensitive)'), value: provider.query });
			if (query?.trim()) {
				await setSearch(query.trim());
			}
		}),
		vscode.commands.registerCommand('agentecode.sessions.clearSearch', () => setSearch(undefined)),

		vscode.commands.registerCommand('agentecode.sessions.resume', async item => {
			if (item?.kind !== 'session') {
				return;
			}
			try {
				await resumeSession(item.id);
			} catch (error) {
				void vscode.window.showErrorMessage(t('Could not open the session in Claude Code: {0}', error.message));
			}
		}),

		vscode.commands.registerCommand('agentecode.sessions.delete', async (item, selection) => {
			const chosen = sessionsFrom(item, selection);
			if (!chosen.length) {
				return;
			}
			const busy = chosen.filter(s => isActiveSession(s.mtime));
			const targets = chosen.filter(s => !isActiveSession(s.mtime));
			if (busy.length) {
				void vscode.window.showWarningMessage(t('{0} session(s) were modified less than 2 minutes ago and seem to be in use. They will not be deleted.', busy.length));
			}
			if (!targets.length) {
				return;
			}

			const names = targets.slice(0, 8).map(s => `• ${s.title}`).join('\n') + (targets.length > 8 ? `\n${t('… and {0} more', targets.length - 8)}` : '');
			const moveLabel = t('Move to Trash');
			const confirm = await vscode.window.showWarningMessage(
				targets.length === 1 ? t('Move this session to the Trash?') : t('Move {0} sessions to the Trash?', targets.length),
				{ modal: true, detail: `${names}\n\n${t('The file copies (checkpoints) of these sessions go along with them. You can recover them from the Windows Recycle Bin.')}` },
				moveLabel
			);
			if (confirm !== moveLabel) {
				return;
			}

			let failed = 0;
			for (const session of targets) {
				for (const artifact of await sessionArtifacts(session.file)) {
					try {
						await vscode.workspace.fs.delete(vscode.Uri.file(artifact), { recursive: true, useTrash: true });
					} catch (error) {
						failed++;
						console.error(`AgenteCode: falha ao excluir ${artifact}`, error);
					}
				}
			}
			provider.refresh();
			if (failed) {
				void vscode.window.showWarningMessage(t('{0} item(s) could not be moved (see the developer console).', failed));
				return;
			}

			// O Claude Code so tira uma sessao da lista dele quando suas telas recarregam.
			const refresh = t('Refresh Claude Code');
			const done = targets.length === 1 ? t('Session moved to the Trash.') : t('{0} sessions moved to the Trash.', targets.length);
			const choice = await vscode.window.showInformationMessage(t('{0} The Claude Code list only updates when its screens reload.', done), refresh);
			if (choice === refresh) {
				await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
			}
		}),

		vscode.commands.registerCommand('agentecode.sessions.rewind', async item => {
			if (item?.kind === 'checkpoint') {
				await rewindToCheckpoint(context, item.session, item);
			}
		}),
		vscode.commands.registerCommand('agentecode.undoLastRewind', () => undoLastRewind(context)),

		vscode.window.onDidChangeWindowState(state => {
			if (state.focused) {
				provider.refresh();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
	);
}

module.exports = { registerSessionsView, SessionsProvider };
