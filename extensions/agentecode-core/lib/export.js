/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const path = require('path');
const { listSessionFiles, readSessionSummary, exportSessionFile, slugify } = require('./sessionMarkdown');
const { t, getLanguage } = require('./i18n');

async function pickSession() {
	const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
	const files = await listSessionFiles(folders);
	if (!files.length) {
		void vscode.window.showInformationMessage(folders.length
			? t('No agent session was found for this folder.')
			: t('No agent session was found.'));
		return;
	}

	const items = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('Reading agent sessions…') }, () =>
		Promise.all(files.map(async f => {
			const summary = await readSessionSummary(f.file);
			return {
				label: summary.title,
				description: new Date(f.mtime).toLocaleString(getLanguage() === 'pt' ? 'pt-BR' : 'en-US'),
				detail: folders.length ? undefined : summary.cwd,
				file: f,
			};
		})));

	return vscode.window.showQuickPick(items, {
		title: t('Export Session to Markdown'),
		placeHolder: t('Choose the session to export'),
		matchOnDetail: true,
	});
}

/**
 * @param {{ kind?: string, title?: string, file?: string, id?: string, mtime?: number }} [sessionItem]
 * Sessao vinda do painel de historico; sem ela, pergunta qual exportar.
 */
async function exportSession(sessionItem) {
	let picked;
	if (sessionItem?.kind === 'session' && sessionItem.file) {
		picked = { label: sessionItem.title, file: { file: sessionItem.file, id: sessionItem.id, mtime: sessionItem.mtime } };
	} else {
		picked = await pickSession();
	}
	if (!picked) {
		return;
	}

	const config = vscode.workspace.getConfiguration('agentecode.export');
	let markdown;
	try {
		markdown = await exportSessionFile(picked.file.file, {
			title: picked.label,
			sessionId: picked.file.id,
			includeToolResults: config.get('includeToolResults', true),
			maxToolResultChars: config.get('maxToolResultChars', 1500),
		});
	} catch (error) {
		void vscode.window.showErrorMessage(t('Could not read the session: {0}', error.message));
		return;
	}

	const date = new Date(picked.file.mtime).toISOString().slice(0, 10);
	const base = vscode.workspace.workspaceFolders?.[0]?.uri;
	const suggestion = base
		? vscode.Uri.joinPath(base, 'docs', 'sessoes', `${date}-${slugify(picked.label)}.md`)
		: vscode.Uri.file(path.join(require('os').homedir(), `${date}-${slugify(picked.label)}.md`));

	const target = await vscode.window.showSaveDialog({
		defaultUri: suggestion,
		filters: { Markdown: ['md'] },
		saveLabel: t('Export'),
		title: t('Save Session as Markdown'),
	});
	if (!target) {
		return;
	}

	await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
	await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));
	const open = t('Open');
	const choice = await vscode.window.showInformationMessage(t('Session exported to {0}.', path.basename(target.fsPath)), open);
	if (choice === open) {
		await vscode.commands.executeCommand('vscode.open', target);
	}
}

/** @param {vscode.ExtensionContext} context */
function registerExport(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('agentecode.exportSessionToMarkdown', exportSession),
	);
}

module.exports = { registerExport };
