/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const { t } = require('../i18n');

/**
 * Exibe a caixa de dialogo modal de consentimento inicial sobre a privacidade do Gist.
 * @returns {Promise<boolean>} true se o usuario clicou em Continuar
 */
async function showConsentModal() {
	const message = t('AgenteCode will store your settings in a secret Gist on your GitHub account. Anyone who has the Gist address can read it, so nothing sensitive is sent (keys and computer paths are left out). Continue?');
	const continueLabel = t('Continue');

	const selection = await vscode.window.showInformationMessage(
		message,
		{ modal: true },
		continueLabel
	);
	return selection === continueLabel;
}

/**
 * Exibe a notificacao com o codigo do dispositivo e oferece copiar e abrir o navegador.
 * @param {string} userCode Codigo amigavel (ex.: 'ABCD-1234')
 * @param {string} verificationUri URL do GitHub (ex.: 'https://github.com/login/device')
 * @returns {Promise<'copied' | 'cancelled'>}
 */
async function showDeviceCodeNotification(userCode, verificationUri) {
	const copyLabel = t('Copy Code and Open GitHub');
	const action = await vscode.window.showInformationMessage(
		t('GitHub activation code: {0}', userCode),
		{ modal: true },
		copyLabel
	);

	if (action === copyLabel) {
		await vscode.env.clipboard.writeText(userCode);
		await vscode.env.openExternal(vscode.Uri.parse(verificationUri));
		return 'copied';
	}
	return 'cancelled';
}

/**
 * Exibe o Quick Pick principal do menu de sincronizacao de acordo com o estado de conexao.
 * @param {object} params
 * @param {boolean} params.isConnected
 * @param {string} [params.userLogin]
 * @param {boolean} [params.isAutoSync]
 * @param {boolean} [params.isClaudeSync]
 * @param {string} [params.lastSyncText]
 * @returns {Promise<string | null>} ID da acao escolhida ou null
 */
async function showQuickPickMenu({ isConnected, userLogin = '', isAutoSync = true, isClaudeSync = false, lastSyncText = '' }) {
	const items = [];

	if (!isConnected) {
		items.push({
			id: 'connect_upload',
			label: t('$(cloud-upload) Connect to GitHub and Upload My Settings'),
			description: t('Creates a secret Gist with your current settings')
		});
		items.push({
			id: 'connect_download',
			label: t('$(cloud-download) Download Settings from Another Computer'),
			description: t('Connects and applies settings from an existing Gist')
		});
		items.push({
			id: 'guide',
			label: t('$(book) View Sync Guide'),
			description: t('Illustrated step-by-step walkthrough')
		});
	} else {
		items.push({
			id: 'upload',
			label: t('$(cloud-upload) Upload Now'),
			description: lastSyncText ? t('Last upload: {0}', lastSyncText) : t('Updates the Gist on GitHub with your local files')
		});
		items.push({
			id: 'download',
			label: t('$(cloud-download) Download from GitHub...'),
			description: t('Compares with the Gist and applies the updates')
		});
		items.push({
			id: 'copy_url',
			label: t('$(link) Copy Gist URL'),
			description: t('Copies the direct link to the clipboard')
		});
		items.push({
			id: 'open_gist',
			label: t('$(globe) Open Gist in Browser'),
			description: t('View your saved files on gist.github.com')
		});
		items.push({
			id: 'toggle_auto',
			label: t('$(sync) Auto sync: {0}', isAutoSync ? t('On') : t('Off')),
			description: isAutoSync ? t('Click to turn off background uploads') : t('Click to turn on automatic upload on save')
		});
		items.push({
			id: 'toggle_claude',
			label: t('$(sparkle) Claude configuration: {0}', isClaudeSync ? t('On') : t('Off')),
			description: isClaudeSync ? t('CLAUDE.md, commands, agents and skills are included') : t('Click to also include CLAUDE.md, commands, agents and skills')
		});
		items.push({
			id: 'undo',
			label: t('$(discard) Undo Last Sync'),
			description: t('Restores the previous backup created on this computer')
		});
		items.push({
			id: 'guide',
			label: t('$(book) View Sync Guide'),
			description: t('Opens the help guide to the side')
		});
		items.push({
			id: 'disconnect',
			label: t('$(sign-out) Disconnect ({0})', userLogin ? '@' + userLogin : 'GitHub'),
			description: t('Removes the local access token (keeps your Gist on GitHub)')
		});
	}

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: isConnected ? `AgenteCode Sync (@${userLogin})` : t('AgenteCode Sync: GitHub Sync'),
		title: t('AgenteCode: Settings Sync')
	});

	return selected ? selected.id : null;
}

/**
 * Exibe a caixa modal de resolucao de conflito entre local e remoto.
 * @returns {Promise<'download' | 'upload' | 'cancel'>}
 */
async function showConflictModal() {
	const downloadLabel = t('Download First');
	const overwriteLabel = t('Overwrite GitHub with This Computer\'s Settings');
	const choice = await vscode.window.showWarningMessage(
		t('Settings changed on this computer and on GitHub as well (conflict detected).'),
		{ modal: true },
		downloadLabel,
		overwriteLabel
	);

	if (choice === downloadLabel) {
		return 'download';
	}
	if (choice === overwriteLabel) {
		return 'upload';
	}
	return 'cancel';
}

/**
 * Exibe a pre-visualizacao do que sera modificado antes de baixar ou aplicar.
 * @param {object} plan Retorno de plan.createSyncPlan
 * @returns {Promise<boolean>} true se o usuario confirmou a aplicacao
 */
async function showPreviewConfirmation(plan) {
	if (plan.warning) {
		const riskLabel = t('I Understand the Risks and Want to Continue');
		const alertChoice = await vscode.window.showWarningMessage(
			plan.warning,
			{ modal: true },
			riskLabel
		);
		if (alertChoice !== riskLabel) {
			return false;
		}
	}

	const totalFiles = (plan.fileDiffs || []).filter(d => d.status !== 'identical').length;
	const totalExt = (plan.extensionsDiff?.toInstall || []).length;
	const totalItems = totalFiles + totalExt;

	if (totalItems === 0) {
		void vscode.window.showInformationMessage(t('Everything is in sync! There are no differences between this computer and GitHub.'));
		return false;
	}

	const message = t('Apply {0} synced item(s)? ({1} file(s), {2} extension(s)). A backup of what exists today will be kept and you will be able to undo.', totalItems, totalFiles, totalExt);
	const applyLabel = t('Apply Now');

	const choice = await vscode.window.showInformationMessage(
		message,
		{ modal: true },
		applyLabel
	);

	return choice === applyLabel;
}

/**
 * Abre um documento Markdown com o resumo completo da operacao de sincronizacao.
 * @param {vscode.ExtensionContext} context
 * @param {string} summaryMarkdown
 */
async function showSummaryDocument(context, summaryMarkdown) {
	try {
		await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
		const summaryFile = path.join(context.globalStorageUri.fsPath, 'resumo-sync.md');
		await fs.promises.writeFile(summaryFile, summaryMarkdown, 'utf8');
		const uri = vscode.Uri.file(summaryFile);
		await vscode.commands.executeCommand('markdown.showPreview', uri);
	} catch {
		// Se nao conseguir abrir o preview, exibe mensagem informativa
		void vscode.window.showInformationMessage(t('Sync completed successfully.'));
	}
}

/**
 * Apresenta mensagens de erro amigaveis sem exibir stack trace para o usuario.
 * @param {any} err
 */
function showFriendlyError(err) {
	const code = err?.code;
	let msg = err?.message || t('An unknown error occurred during sync.');

	if (code === 'NETWORK_ERROR' || err?.name === 'GistNetworkError') {
		msg = t('Could not connect to GitHub. Check your internet connection.');
	} else if (code === 'TOKEN_REVOKED' || code === 'UNAUTHORIZED' || err?.status === 401) {
		msg = t('Your GitHub connection expired or the token was revoked. Please connect again.');
	} else if (code === 'FORBIDDEN') {
		msg = t('Insufficient permission on the GitHub account to manage Gists. Try disconnecting and reconnecting.');
	} else if (code === 'RATE_LIMIT_EXCEEDED' || code === 'RATE_LIMIT') {
		msg = t('Temporary GitHub request limit reached. Please wait a few minutes before trying again.');
	} else if (code === 'TRUNCATED') {
		msg = t('A file received from GitHub was truncated and the full content could not be downloaded safely.');
	} else if (code === 'EXPIRED_TOKEN') {
		msg = t('The activation code expired. Please start the connection again.');
	} else if (code === 'ACCESS_DENIED') {
		msg = t('The authorization was cancelled in the browser.');
	}

	void vscode.window.showErrorMessage(msg);
}

/**
 * Cria e configura o item da barra de status do AgenteCode Sync.
 * @param {vscode.ExtensionContext} context
 * @returns {vscode.StatusBarItem}
 */
function createSyncStatusBar(context) {
	const statusBar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		9990
	);
	statusBar.name = 'AgenteCode Sync';
	statusBar.command = 'agentecode.sync.menu';
	statusBar.text = '$(cloud) Sync';
	statusBar.tooltip = t('AgenteCode: Settings Sync');
	statusBar.show();
	context.subscriptions.push(statusBar);
	return statusBar;
}

/**
 * Atualiza o estado visual da barra de status.
 * @param {vscode.StatusBarItem} statusBar
 * @param {'idle' | 'syncing' | 'synced' | 'conflict' | 'offline'} state
 * @param {string} [tooltipExtra]
 */
function updateStatusBar(statusBar, state, tooltipExtra = '') {
	if (!statusBar) {
		return;
	}

	const baseTooltip = t('AgenteCode: GitHub Sync');
	const fullTooltip = tooltipExtra ? `${baseTooltip}\n${tooltipExtra}` : baseTooltip;

	switch (state) {
		case 'syncing':
			statusBar.text = t('$(sync~spin) Syncing...');
			statusBar.tooltip = `${baseTooltip}\n${t('Syncing settings...')}`;
			break;
		case 'synced':
			statusBar.text = t('$(check) Synced');
			statusBar.tooltip = fullTooltip;
			break;
		case 'conflict':
			statusBar.text = t('$(warning) Sync: Conflict');
			statusBar.tooltip = `${baseTooltip}\n${t('Conflict detected. Click to resolve.')}`;
			break;
		case 'offline':
			statusBar.text = t('$(cloud-offline) Sync: Offline');
			statusBar.tooltip = `${baseTooltip}\n${t('No connection to GitHub.')}`;
			break;
		default:
			statusBar.text = '$(cloud) Sync';
			statusBar.tooltip = fullTooltip;
			break;
	}
}

module.exports = {
	showConsentModal,
	showDeviceCodeNotification,
	showQuickPickMenu,
	showConflictModal,
	showPreviewConfirmation,
	showSummaryDocument,
	showFriendlyError,
	createSyncStatusBar,
	updateStatusBar
};
