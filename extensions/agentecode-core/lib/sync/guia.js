/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const { t, getLanguage } = require('../i18n');

const GUIDE_SHOWN_KEY = 'agentecode.sync.guideShown';

/**
 * Avalia de forma pura se o guia deve ser exibido na primeira vez.
 * @param {boolean | undefined} guideShownState
 * @returns {boolean}
 */
function isFirstTimeGuide(guideShownState) {
	return !guideShownState;
}

/**
 * Marca que o guia ja foi apresentado ao usuario.
 * @param {vscode.ExtensionContext} context
 */
async function markGuideShown(context) {
	if (context && context.globalState) {
		await context.globalState.update(GUIDE_SHOWN_KEY, true);
	}
}

/**
 * Abre o arquivo guia.md na visualizacao de Markdown ao lado.
 * @param {vscode.ExtensionContext} context
 */
async function openGuide(context) {
	const guidePath = path.join(context.extensionPath, 'media', 'sync', getLanguage() === 'pt' ? 'guia.pt-br.md' : 'guia.md');
	if (!fs.existsSync(guidePath)) {
		void vscode.window.showWarningMessage(t('Sync guide file not found.'));
		return;
	}

	const uri = vscode.Uri.file(guidePath);
	try {
		await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
	} catch {
		// Fallback para abrir como documento normal se o preview de markdown nao responder
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
	}
}

/**
 * Registra o comando do guia de sincronizacao.
 * @param {vscode.ExtensionContext} context
 */
function registerGuide(context) {
	const disposable = vscode.commands.registerCommand('agentecode.sync.guide', async () => {
		await openGuide(context);
	});
	context.subscriptions.push(disposable);
	return disposable;
}

module.exports = {
	GUIDE_SHOWN_KEY,
	isFirstTimeGuide,
	markGuideShown,
	openGuide,
	registerGuide
};
