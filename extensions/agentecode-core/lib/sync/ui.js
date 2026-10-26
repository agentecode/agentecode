/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

/**
 * Exibe a caixa de dialogo modal de consentimento inicial sobre a privacidade do Gist.
 * @returns {Promise<boolean>} true se o usuario clicou em Continuar
 */
async function showConsentModal() {
	const message = 'O AgenteCode vai guardar suas configurações num Gist secreto da sua conta do GitHub. ' +
		'Quem tiver o endereço do Gist consegue ler, então nada sensível será enviado (chaves e caminhos do computador ficam de fora). Continuar?';

	const selection = await vscode.window.showInformationMessage(
		message,
		{ modal: true },
		'Continuar'
	);
	return selection === 'Continuar';
}

/**
 * Exibe a notificacao com o codigo do dispositivo e oferece copiar e abrir o navegador.
 * @param {string} userCode Codigo amigavel (ex.: 'ABCD-1234')
 * @param {string} verificationUri URL do GitHub (ex.: 'https://github.com/login/device')
 * @returns {Promise<'copied' | 'cancelled'>}
 */
async function showDeviceCodeNotification(userCode, verificationUri) {
	const action = await vscode.window.showInformationMessage(
		`Código de ativação do GitHub: ${userCode}`,
		{ modal: true },
		'Copiar código e abrir o GitHub'
	);

	if (action === 'Copiar código e abrir o GitHub') {
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
			label: '$(cloud-upload) Conectar ao GitHub e enviar minhas configurações',
			description: 'Cria um Gist secreto com suas configurações atuais'
		});
		items.push({
			id: 'connect_download',
			label: '$(cloud-download) Baixar configurações de outro computador',
			description: 'Conecta e aplica configurações de um Gist existente'
		});
		items.push({
			id: 'guide',
			label: '$(book) Ver guia de sincronização',
			description: 'Passo a passo explicativo ilustrado'
		});
	} else {
		items.push({
			id: 'upload',
			label: '$(cloud-upload) Enviar agora',
			description: lastSyncText ? `Último envio: ${lastSyncText}` : 'Atualiza o Gist no GitHub com seus arquivos locais'
		});
		items.push({
			id: 'download',
			label: '$(cloud-download) Baixar do GitHub...',
			description: 'Compara com o Gist e aplica as atualizações'
		});
		items.push({
			id: 'copy_url',
			label: '$(link) Copiar URL do Gist',
			description: 'Copia o link direto para a área de transferência'
		});
		items.push({
			id: 'open_gist',
			label: '$(globe) Abrir Gist no navegador',
			description: 'Visualiza seus arquivos salvos em gist.github.com'
		});
		items.push({
			id: 'toggle_auto',
			label: `$(sync) Sincronização automática: ${isAutoSync ? 'Ligada' : 'Desligada'}`,
			description: isAutoSync ? 'Clique para desativar o envio em segundo plano' : 'Clique para ativar o envio automático ao salvar'
		});
		items.push({
			id: 'toggle_claude',
			label: `$(sparkle) Configuração do Claude: ${isClaudeSync ? 'Ligada' : 'Desligada'}`,
			description: isClaudeSync ? 'CLAUDE.md, comandos, agentes e skills vão junto' : 'Clique para levar também CLAUDE.md, comandos, agentes e skills'
		});
		items.push({
			id: 'undo',
			label: '$(discard) Desfazer a última sincronização',
			description: 'Restaura o backup anterior criado neste computador'
		});
		items.push({
			id: 'guide',
			label: '$(book) Ver guia de sincronização',
			description: 'Abre o guia de ajuda ao lado'
		});
		items.push({
			id: 'disconnect',
			label: `$(sign-out) Desconectar (${userLogin ? '@' + userLogin : 'GitHub'})`,
			description: 'Remove o token de acesso local (mantém seu Gist no GitHub)'
		});
	}

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: isConnected ? `AgenteCode Sync (@${userLogin})` : 'AgenteCode Sync: Sincronização com o GitHub',
		title: 'AgenteCode: Sincronização de Configurações'
	});

	return selected ? selected.id : null;
}

/**
 * Exibe a caixa modal de resolucao de conflito entre local e remoto.
 * @returns {Promise<'download' | 'upload' | 'cancel'>}
 */
async function showConflictModal() {
	const choice = await vscode.window.showWarningMessage(
		'As configurações mudaram neste computador e também no GitHub (conflito detectado).',
		{ modal: true },
		'Baixar primeiro',
		'Sobrescrever o GitHub com as deste computador'
	);

	if (choice === 'Baixar primeiro') {
		return 'download';
	}
	if (choice === 'Sobrescrever o GitHub com as deste computador') {
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
		const alertChoice = await vscode.window.showWarningMessage(
			plan.warning,
			{ modal: true },
			'Entendi os riscos e quero continuar'
		);
		if (alertChoice !== 'Entendi os riscos e quero continuar') {
			return false;
		}
	}

	const totalFiles = (plan.fileDiffs || []).filter(d => d.status !== 'identical').length;
	const totalExt = (plan.extensionsDiff?.toInstall || []).length;
	const totalItems = totalFiles + totalExt;

	if (totalItems === 0) {
		void vscode.window.showInformationMessage('Tudo sincronizado! Não há diferenças entre este computador e o GitHub.');
		return false;
	}

	const message = `Aplicar ${totalItems} item(ns) sincronizados? ` +
		`(${totalFiles} arquivo(s), ${totalExt} extensão(ões)). ` +
		'Uma cópia de segurança do que existe hoje será guardada e você poderá desfazer.';

	const choice = await vscode.window.showInformationMessage(
		message,
		{ modal: true },
		'Aplicar agora'
	);

	return choice === 'Aplicar agora';
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
		void vscode.window.showInformationMessage('Sincronização concluída com sucesso.');
	}
}

/**
 * Apresenta mensagens de erro amigaveis sem exibir stack trace para o usuario.
 * @param {any} err
 */
function showFriendlyError(err) {
	const code = err?.code;
	let msg = err?.message || 'Ocorreu um erro desconhecido durante a sincronização.';

	if (code === 'NETWORK_ERROR' || err?.name === 'GistNetworkError') {
		msg = 'Não foi possível conectar ao GitHub. Verifique sua conexão com a internet.';
	} else if (code === 'TOKEN_REVOKED' || code === 'UNAUTHORIZED' || err?.status === 401) {
		msg = 'Sua conexão com o GitHub expirou ou o token foi revogado. Por favor, conecte-se novamente.';
	} else if (code === 'FORBIDDEN') {
		msg = 'Permissão insuficiente na conta do GitHub para gerenciar Gists. Tente desconectar e reconectar.';
	} else if (code === 'RATE_LIMIT_EXCEEDED' || code === 'RATE_LIMIT') {
		msg = 'Limite temporário de requisições ao GitHub atingido. Por favor, aguarde alguns minutos antes de tentar novamente.';
	} else if (code === 'TRUNCATED') {
		msg = 'Um arquivo recebido do GitHub estava truncado e o conteúdo completo não pôde ser baixado com segurança.';
	} else if (code === 'EXPIRED_TOKEN') {
		msg = 'O código de ativação expirou. Por favor, inicie a conexão novamente.';
	} else if (code === 'ACCESS_DENIED') {
		msg = 'A autorização foi cancelada no navegador.';
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
	statusBar.tooltip = 'AgenteCode: Sincronização de Configurações';
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

	const baseTooltip = 'AgenteCode: Sincronização com o GitHub';
	const fullTooltip = tooltipExtra ? `${baseTooltip}\n${tooltipExtra}` : baseTooltip;

	switch (state) {
		case 'syncing':
			statusBar.text = '$(sync~spin) Sincronizando...';
			statusBar.tooltip = `${baseTooltip}\nSincronizando configurações...`;
			break;
		case 'synced':
			statusBar.text = '$(check) Sincronizado';
			statusBar.tooltip = fullTooltip;
			break;
		case 'conflict':
			statusBar.text = '$(warning) Sync: Conflito';
			statusBar.tooltip = `${baseTooltip}\nConflito detectado. Clique para resolver.`;
			break;
		case 'offline':
			statusBar.text = '$(cloud-offline) Sync: Offline';
			statusBar.tooltip = `${baseTooltip}\nSem conexão com o GitHub.`;
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
