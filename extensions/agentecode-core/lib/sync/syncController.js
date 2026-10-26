/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const config = require('./config');
const githubAuth = require('./githubAuth');
const gistClient = require('./gistClient');
const snapshot = require('./snapshot');
const plan = require('./plan');
const backup = require('./backup');
const { isFirstTimeGuide, markGuideShown, openGuide, GUIDE_SHOWN_KEY } = require('./guia');
const ui = require('./ui');
const claudeConfig = require('./claudeConfig');
const { mergeExcludedSettings } = require('./exclusions');

const TOKEN_SECRET_KEY = 'agentecode.sync.githubToken';
const LAST_SYNC_KEY = 'agentecode.sync.lastSync';
const USER_LOGIN_KEY = 'agentecode.sync.userLogin';
const MACHINE_ID_KEY = 'agentecode.sync.machineId';

class SyncController {
	/**
	 * @param {vscode.ExtensionContext} context
	 */
	constructor(context) {
		this.context = context;
		this.statusBar = ui.createSyncStatusBar(context);
		this.log = vscode.window.createOutputChannel('AgenteCode Sync', { log: true });
		this.autoSyncTimer = null;
		this.isSyncing = false;

		// Localizacao das pastas
		this.userDir = this._resolveUserDir();
		this.backupDir = path.join(context.globalStorageUri.fsPath, 'backups');
		this.claudeDir = path.join(os.homedir(), '.claude');

		this.log.info('AgenteCode Sync inicializado. Diretório de usuário:', this.userDir);
	}

	_resolveUserDir() {
		// No VS Code, o pai de globalStorage/.. e a pasta User
		try {
			const candidate = path.dirname(path.dirname(this.context.globalStorageUri.fsPath));
			if (path.basename(candidate).toLowerCase() === 'user') {
				return candidate;
			}
		} catch {
			// fallback
		}

		// Fallback por plataforma caso globalStorageUri tenha layout customizado
		const appData = process.env.APPDATA || (
			process.platform === 'darwin'
				? path.join(os.homedir(), 'Library', 'Application Support')
				: path.join(os.homedir(), '.config')
		);
		return path.join(appData, 'AgenteCode', 'User');
	}

	async getStoredToken() {
		return this.context.secrets.get(TOKEN_SECRET_KEY);
	}

	async setStoredToken(token) {
		await this.context.secrets.store(TOKEN_SECRET_KEY, token);
	}

	async deleteStoredToken() {
		await this.context.secrets.delete(TOKEN_SECRET_KEY);
	}

	getLastSync() {
		return this.context.globalState.get(LAST_SYNC_KEY) || null;
	}

	async setLastSync(data) {
		await this.context.globalState.update(LAST_SYNC_KEY, data);
	}

	getUserLogin() {
		return this.context.globalState.get(USER_LOGIN_KEY) || '';
	}

	async setUserLogin(login) {
		await this.context.globalState.update(USER_LOGIN_KEY, login);
	}

	getMachineId() {
		let id = this.context.globalState.get(MACHINE_ID_KEY);
		if (!id) {
			id = crypto.randomUUID();
			void this.context.globalState.update(MACHINE_ID_KEY, id);
		}
		return id;
	}

	isAutoSyncEnabled() {
		return vscode.workspace.getConfiguration('agentecode.sync').get('auto', true);
	}

	isClaudeSyncEnabled() {
		return vscode.workspace.getConfiguration('agentecode.sync').get('syncClaudeConfig', false);
	}

	/** Pasta ~/.claude somente quando o usuario ligou a sincronizacao da configuracao do Claude. */
	_claudeDirIfEnabled() {
		return this.isClaudeSyncEnabled() ? this.claudeDir : null;
	}

	getCustomExclusions() {
		return vscode.workspace.getConfiguration('agentecode.sync').get('excludedSettings', []);
	}

	/**
	 * Exibe o menu principal de acoes do Quick Pick.
	 * Na primeira utilizacao, abre o guia em Markdown ao lado antes de apresentar as opcoes.
	 */
	async showMenu() {
		const guideShown = this.context.globalState.get(GUIDE_SHOWN_KEY);
		if (isFirstTimeGuide(guideShown)) {
			this.log.info('Primeiro uso detectado: abrindo guia de sincronização ao lado.');
			await openGuide(this.context);
			await markGuideShown(this.context);
		}

		const token = await this.getStoredToken();
		const isConnected = Boolean(token);
		const userLogin = this.getUserLogin();
		const isAutoSync = this.isAutoSyncEnabled();

		const lastSync = this.getLastSync();
		let lastSyncText = '';
		if (lastSync && lastSync.timestamp) {
			lastSyncText = new Date(lastSync.timestamp).toLocaleString('pt-BR');
		}

		const action = await ui.showQuickPickMenu({
			isConnected,
			userLogin,
			isAutoSync,
			isClaudeSync: this.isClaudeSyncEnabled(),
			lastSyncText
		});

		if (!action) {
			return;
		}

		switch (action) {
			case 'connect_upload':
				await this.connectAndUpload();
				break;
			case 'connect_download':
			case 'download':
				await this.downloadFromGitHub();
				break;
			case 'upload':
				await this.uploadNow();
				break;
			case 'copy_url':
				await this.copyGistUrl();
				break;
			case 'open_gist':
				await this.openGist();
				break;
			case 'toggle_auto':
				await this.toggleAutoSync();
				break;
			case 'toggle_claude':
				await this.toggleClaudeSync();
				break;
			case 'undo':
				await this.undoLastSync();
				break;
			case 'guide':
				await openGuide(this.context);
				break;
			case 'disconnect':
				await this.disconnect();
				break;
		}
	}

	/**
	 * Autentica o usuario via Device Flow (sem digitar token manual).
	 * @returns {Promise<string | null>} Token obtido ou null se cancelado
	 */
	async authenticate() {
		let token = await this.getStoredToken();
		if (token) {
			return token;
		}

		const consent = await ui.showConsentModal();
		if (!consent) {
			return null;
		}

		this.log.info('Iniciando Device Flow do GitHub...');
		const flow = await githubAuth.startDeviceFlow();

		const notificationResult = await ui.showDeviceCodeNotification(
			flow.user_code,
			flow.verification_uri
		);

		if (notificationResult === 'cancelled') {
			this.log.info('Autorização cancelada pelo usuário na notificação.');
			return null;
		}

		// Aguarda o usuario autorizar com barra de progresso cancelavel
		const authResult = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'AgenteCode Sync: Aguardando autorização no navegador...',
				cancellable: true
			},
			async (_, progressToken) => {
				const abortController = new AbortController();
				progressToken.onCancellationRequested(() => {
					abortController.abort();
				});

				return githubAuth.pollForToken({
					deviceCode: flow.device_code,
					interval: flow.interval,
					expiresIn: flow.expires_in,
					signal: abortController.signal
				});
			}
		);

		if (!authResult || !authResult.accessToken) {
			return null;
		}

		token = authResult.accessToken;
		await this.setStoredToken(token);

		// Obtem nome de login do usuario
		try {
			const userInfo = await githubAuth.getUser(token);
			await this.setUserLogin(userInfo.login);
			this.log.info(`Conectado com sucesso como @${userInfo.login}`);
		} catch (err) {
			this.log.warn('Não foi possível obter detalhes do perfil:', err.message);
		}

		return token;
	}

	/**
	 * Conecta ao GitHub e realiza o envio inicial de configuracoes.
	 */
	async connectAndUpload() {
		try {
			const token = await this.authenticate();
			if (!token) {
				return;
			}

			ui.updateStatusBar(this.statusBar, 'syncing');

			const outcome = await this._uploadWithToken(token, 'Primeiro envio de configurações');
			if (outcome === 'download') {
				await this.downloadFromGitHub();
				return;
			}
			if (outcome !== 'uploaded' && outcome !== 'skipped') {
				ui.updateStatusBar(this.statusBar, outcome === 'notifyDownload' ? 'idle' : 'conflict');
				if (outcome === 'notifyDownload') {
					void vscode.window.showInformationMessage('O GitHub já tem configurações mais novas. Use "Baixar do GitHub" no menu para aplicá-las.');
				}
				return;
			}

			const lastSync = this.getLastSync();
			const gistUrl = lastSync ? lastSync.gistUrl : '';
			const login = this.getUserLogin();

			ui.updateStatusBar(this.statusBar, 'synced', `Conectado como @${login}`);

			const action = await vscode.window.showInformationMessage(
				`Conectado como @${login}! Suas configurações foram enviadas com sucesso para um Gist secreto.`,
				'Copiar URL do Gist',
				'Abrir no navegador'
			);

			if (action === 'Copiar URL do Gist' && gistUrl) {
				await vscode.env.clipboard.writeText(gistUrl);
			} else if (action === 'Abrir no navegador' && gistUrl) {
				await vscode.env.openExternal(vscode.Uri.parse(gistUrl));
			}
		} catch (err) {
			this.log.error('Erro em connectAndUpload:', err);
			ui.updateStatusBar(this.statusBar, 'idle');
			ui.showFriendlyError(err);
		}
	}

	/**
	 * Realiza o upload das configuracoes locais para o Gist.
	 */
	async uploadNow() {
		try {
			const token = await this.getStoredToken();
			if (!token) {
				await this.connectAndUpload();
				return;
			}

			ui.updateStatusBar(this.statusBar, 'syncing');
			const outcome = await this._uploadWithToken(token, 'Envio manual');
			if (outcome === 'download') {
				await this.downloadFromGitHub();
			} else if (outcome === 'cancelled' || outcome === 'blocked') {
				ui.updateStatusBar(this.statusBar, 'conflict');
			} else if (outcome === 'notifyDownload') {
				ui.updateStatusBar(this.statusBar, 'idle');
				void vscode.window.showInformationMessage('O GitHub tem configurações mais novas que as deste computador. Use "Baixar do GitHub" para aplicá-las.');
			} else if (outcome === 'skipped') {
				ui.updateStatusBar(this.statusBar, 'synced', 'Configurações sincronizadas');
				void vscode.window.showInformationMessage('Nada a enviar: tudo já está igual ao GitHub.');
			} else {
				ui.updateStatusBar(this.statusBar, 'synced', 'Configurações sincronizadas');
				void vscode.window.showInformationMessage('Configurações enviadas para o GitHub com sucesso.');
			}
		} catch (err) {
			this.log.error('Erro em uploadNow:', err);
			ui.updateStatusBar(this.statusBar, 'idle');
			ui.showFriendlyError(err);
		}
	}

	/**
	 * Envia as configuracoes locais para o Gist, mas so depois de compara-las com o remoto.
	 * @param {string} token
	 * @param {string} reason
	 * @param {{auto?: boolean, force?: boolean}} [options] force sobrescreve o remoto sem comparar (decisao explicita do usuario)
	 * @returns {Promise<'uploaded'|'skipped'|'notifyDownload'|'blocked'|'cancelled'|'download'>}
	 */
	async _uploadWithToken(token, reason = '', options = {}) {
		this.isSyncing = true;
		try {
			const customExclusions = this.getCustomExclusions();
			const localSnap = await snapshot.createLocalSnapshot({
				userDir: this.userDir,
				readFile: p => fs.promises.readFile(p, 'utf8').catch(() => null),
				readDir: d => fs.promises.readdir(d).catch(() => []),
				listUserExtensions: async () => {
					return vscode.extensions.all
						.filter(ext => !ext.packageJSON.isBuiltin)
						.map(ext => ext.id.toLowerCase());
				},
				customExclusions,
				claudeDir: this._claudeDirIfEnabled()
			});

			const manifestJson = snapshot.buildManifest(localSnap, {
				appVersion: vscode.version,
				id: this.getMachineId(),
				name: os.hostname(),
				platform: process.platform
			});

			// Monta o payload de arquivos para o Gist
			const gistFiles = {
				[config.MANIFEST_FILE]: { content: manifestJson }
			};

			for (const [name, content] of Object.entries(localSnap.files)) {
				gistFiles[name] = { content };
			}

			// Procura Gist existente ou cria novo
			let gist = await gistClient.findSyncGist(token);
			if (!gist) {
				this.log.info('Nenhum Gist de sincronização existente encontrado. Criando novo Gist secreto...');
				gist = await gistClient.createGist(token, {
					description: config.GIST_DESCRIPTION,
					isPublic: false,
					files: gistFiles
				});
			} else {
				const login = this.getUserLogin();
				if (login && !gistClient.isGistOwner(gist, login)) {
					throw new Error('Não é permitido sobrescrever automaticamente o Gist pertencente a outro usuário.');
				}

				if (!options.force) {
					// Nunca sobrescreve o remoto sem ler o que ha la
					const details = await gistClient.getGist(token, gist.id);
					const fullGist = details.gist || gist;
					const remoteData = snapshot.parseRemoteGistFiles(fullGist.files);
					const syncPlan = plan.createSyncPlan({
						localSnapshot: localSnap,
						remoteFiles: remoteData.files,
						remoteManifest: remoteData.manifest,
						remoteUpdatedAt: fullGist.updated_at,
						base: this.getLastSync(),
						gist: fullGist,
						currentLogin: login
					});
					const decision = plan.decideUpload(syncPlan, { auto: Boolean(options.auto) });

					if (decision === 'skip') {
						this.log.info('Nada a enviar: local e GitHub já estão iguais.');
						return 'skipped';
					}
					if (decision === 'notifyDownload') {
						this.log.info('O GitHub tem configurações mais novas; envio não necessário.');
						return 'notifyDownload';
					}
					if (decision === 'blocked') {
						this.log.warn('Envio automático bloqueado: o GitHub mudou. É preciso resolver manualmente.');
						return 'blocked';
					}
					if (decision === 'askConflict') {
						const choice = await ui.showConflictModal();
						if (choice === 'download') {
							return 'download';
						}
						if (choice !== 'upload') {
							return 'cancelled';
						}
					}
				}

				this.log.info(`Atualizando Gist (${gist.id})...`);
				gist = await gistClient.updateGist(token, gist.id, {
					files: gistFiles
				});
			}

			await this.setLastSync({
				gistId: gist.id,
				gistUrl: gist.html_url,
				remoteUpdatedAt: gist.updated_at,
				manifestHash: localSnap.compositeHash,
				localHash: localSnap.compositeHash,
				timestamp: Date.now(),
				reason
			});
			this.log.info('Upload concluído com sucesso. Gist:', gist.html_url);
			return 'uploaded';
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Baixa configuracoes do Gist no GitHub e aplica localmente apos confirmacao.
	 */
	async downloadFromGitHub() {
		try {
			const token = await this.authenticate();
			if (!token) {
				return;
			}

			ui.updateStatusBar(this.statusBar, 'syncing');

			const gist = await gistClient.findSyncGist(token);
			if (!gist) {
				void vscode.window.showInformationMessage('Nenhum Gist de sincronização foi encontrado na sua conta do GitHub.');
				ui.updateStatusBar(this.statusBar, 'idle');
				return;
			}

			const gistDetails = await gistClient.getGist(token, gist.id);
			const fullGist = gistDetails.gist || gist;

			const remoteData = snapshot.parseRemoteGistFiles(fullGist.files);
			if (!this.isClaudeSyncEnabled()) {
				// Sem a opcao ligada, a configuracao do Claude que estiver no Gist e ignorada
				for (const name of Object.keys(remoteData.files)) {
					if (claudeConfig.isClaudeGistName(name)) {
						delete remoteData.files[name];
					}
				}
			}

			const customExclusions = this.getCustomExclusions();
			const localSnap = await snapshot.createLocalSnapshot({
				userDir: this.userDir,
				readFile: p => fs.promises.readFile(p, 'utf8').catch(() => null),
				readDir: d => fs.promises.readdir(d).catch(() => []),
				listUserExtensions: async () => {
					return vscode.extensions.all
						.filter(ext => !ext.packageJSON.isBuiltin)
						.map(ext => ext.id.toLowerCase());
				},
				customExclusions,
				claudeDir: this._claudeDirIfEnabled()
			});

			const base = this.getLastSync();
			const login = this.getUserLogin();

			const syncPlan = plan.createSyncPlan({
				localSnapshot: localSnap,
				remoteFiles: remoteData.files,
				remoteManifest: remoteData.manifest,
				remoteUpdatedAt: fullGist.updated_at,
				base,
				gist: fullGist,
				currentLogin: login
			});

			// Se houver conflito bidirecional, pergunta a decisao
			if (syncPlan.action === 'conflict') {
				const conflictDecision = await ui.showConflictModal();
				if (conflictDecision === 'upload') {
					await this._uploadWithToken(token, 'Resolução de conflito: sobrescrever remoto', { force: true });
					ui.updateStatusBar(this.statusBar, 'synced');
					void vscode.window.showInformationMessage('GitHub atualizado com as configurações deste computador.');
					return;
				}
				if (conflictDecision !== 'download') {
					ui.updateStatusBar(this.statusBar, 'conflict');
					return;
				}
			}

			// Pre-visualizacao e confirmacao
			const confirmed = await ui.showPreviewConfirmation(syncPlan);
			if (!confirmed) {
				ui.updateStatusBar(this.statusBar, 'idle');
				return;
			}

			// Realiza backup local antes de aplicar
			const claudePathsToBackup = this.isClaudeSyncEnabled()
				? Object.keys(remoteData.files)
					.filter(name => claudeConfig.isClaudeGistName(name))
					.map(name => claudeConfig.restoreClaudePath(name, remoteData.manifest && remoteData.manifest.claudePaths))
					.filter(Boolean)
				: [];
			await backup.createBackup(this.userDir, this.backupDir, { claudeDir: this.claudeDir, claudePaths: claudePathsToBackup });

			// Aplica os arquivos do Gist
			await this._applyRemoteFiles(remoteData.files, remoteData.manifest);

			// Instala extensoes pendentes
			const installedExts = [];
			const failedExts = [];
			if (syncPlan.extensionsDiff && syncPlan.extensionsDiff.toInstall.length > 0) {
				const toInstall = syncPlan.extensionsDiff.toInstall;
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Instalando extensões sincronizadas...',
						cancellable: false
					},
					async progress => {
						for (let i = 0; i < toInstall.length; i++) {
							const extId = toInstall[i];
							progress.report({
								message: `${extId} (${i + 1}/${toInstall.length})`,
								increment: 100 / toInstall.length
							});
							try {
								await vscode.commands.executeCommand('workbench.extensions.installExtension', extId);
								installedExts.push(extId);
							} catch (e) {
								failedExts.push({ id: extId, error: e.message });
							}
						}
					}
				);
			}

			// Atualiza estado local
			const updatedLocalSnap = await snapshot.createLocalSnapshot({
				userDir: this.userDir,
				readFile: p => fs.promises.readFile(p, 'utf8').catch(() => null),
				readDir: d => fs.promises.readdir(d).catch(() => []),
				customExclusions,
				claudeDir: this._claudeDirIfEnabled()
			});

			await this.setLastSync({
				gistId: fullGist.id,
				gistUrl: fullGist.html_url,
				remoteUpdatedAt: fullGist.updated_at,
				etag: gistDetails.etag,
				manifestHash: remoteData.manifest?.compositeHash || updatedLocalSnap.compositeHash,
				localHash: updatedLocalSnap.compositeHash,
				timestamp: Date.now(),
				reason: 'Download do GitHub aplicado'
			});

			ui.updateStatusBar(this.statusBar, 'synced');

			// Gera e abre o resumo em Markdown
			const summaryMd = this._buildSummaryMarkdown({
				plan: syncPlan,
				installedExts,
				failedExts,
				gistUrl: fullGist.html_url
			});
			await ui.showSummaryDocument(this.context, summaryMd);
		} catch (err) {
			this.log.error('Erro em downloadFromGitHub:', err);
			ui.updateStatusBar(this.statusBar, 'idle');
			ui.showFriendlyError(err);
		}
	}

	async _writeFileAtomic(dest, content) {
		const tmp = `${dest}.agentecode-tmp`;
		await fs.promises.writeFile(tmp, content, 'utf8');
		await fs.promises.rename(tmp, dest);
	}

	async _applyRemoteFiles(files, remoteManifest) {
		const snippetsDir = path.join(this.userDir, 'snippets');
		await fs.promises.mkdir(snippetsDir, { recursive: true });

		for (const [name, content] of Object.entries(files)) {
			if (name === config.MANIFEST_FILE || name === config.README_FILE || name === config.EXTENSIONS_FILE) {
				continue;
			}

			if (name === config.SETTINGS_FILE || name === config.KEYBINDINGS_FILE) {
				const dest = path.join(this.userDir, name);
				let finalContent = content;
				if (name === config.SETTINGS_FILE) {
					// Mantem o que nunca sai deste computador (chaves, caminhos, config do sync)
					const localText = await fs.promises.readFile(dest, 'utf8').catch(() => null);
					finalContent = mergeExcludedSettings(content, localText, this.getCustomExclusions());
				}
				await this._writeFileAtomic(dest, finalContent);
				continue;
			}

			// Configuracao do Claude (so entra se o manifesto mapeia o arquivo e o caminho e seguro)
			if (claudeConfig.isClaudeGistName(name)) {
				if (!this.isClaudeSyncEnabled()) {
					continue;
				}
				const rel = claudeConfig.restoreClaudePath(name, remoteManifest && remoteManifest.claudePaths);
				const target = rel ? claudeConfig.resolveClaudePath(this.claudeDir, rel) : null;
				if (target) {
					await fs.promises.mkdir(path.dirname(target), { recursive: true });
					await this._writeFileAtomic(target, content);
				}
				continue;
			}

			// Snippets
			if (name.startsWith(config.SNIPPET_PREFIX)) {
				const safeName = snapshot.restoreSnippetName(name, remoteManifest?.files);
				if (safeName) {
					const targetPath = snapshot.resolveSnippetPath(snippetsDir, safeName);
					if (targetPath) {
						await this._writeFileAtomic(targetPath, content);
					}
				}
			}
		}
	}

	_buildSummaryMarkdown({ plan, installedExts, failedExts, gistUrl }) {
		let md = '# Resumo da Sincronização — AgenteCode\n\n';
		md += `Sincronização aplicada com sucesso em **${new Date().toLocaleString('pt-BR')}**.\n\n`;

		md += '## Arquivos de Configuração Atualizados\n\n';
		for (const diff of plan.fileDiffs || []) {
			if (diff.status !== 'identical') {
				const icon = diff.status === 'remoteOnly' ? '➕ Adicionado' : '🔄 Atualizado';
				md += `- **${diff.file}**: ${icon}\n`;
			}
		}

		if (installedExts.length > 0) {
			md += '\n## Extensões Instaladas\n\n';
			for (const ext of installedExts) {
				md += `- \`${ext}\`\n`;
			}
		}

		if (failedExts.length > 0) {
			md += '\n## Extensões com Falha na Instalação\n\n';
			for (const f of failedExts) {
				md += `- \`${f.id}\` (erro: ${f.error})\n`;
			}
		}

		md += `\n---\n*Gist sincronizado: [${gistUrl}](${gistUrl})*\n`;
		md += '\n> **Dica:** Uma cópia dos seus arquivos anteriores foi guardada. Caso queira reverter, selecione **Desfazer a última sincronização** no menu.\n';
		return md;
	}

	async undoLastSync() {
		try {
			const backups = await backup.listBackups(this.backupDir);
			if (backups.length === 0) {
				void vscode.window.showWarningMessage('Nenhum backup recente foi encontrado para restauração.');
				return;
			}
			const choice = await vscode.window.showWarningMessage(
				`Restaurar os arquivos de ${new Date(backups[0].createdAt).toLocaleString('pt-BR')}? Os arquivos atuais serão substituídos pelos guardados antes da última sincronização.`,
				{ modal: true },
				'Restaurar'
			);
			if (choice !== 'Restaurar') {
				return;
			}
			const { restoredFiles } = await backup.restoreBackup(backups[0].backupPath, this.userDir, this.claudeDir);
			void vscode.window.showInformationMessage(`A última sincronização foi desfeita (${restoredFiles.length} arquivo(s) restaurado(s)).`);
			this.log.info('Backup restaurado com sucesso:', restoredFiles.join(', '));
		} catch (err) {
			this.log.error('Erro ao desfazer sincronização:', err);
			ui.showFriendlyError(err);
		}
	}

	async copyGistUrl() {
		const lastSync = this.getLastSync();
		if (lastSync && lastSync.gistUrl) {
			await vscode.env.clipboard.writeText(lastSync.gistUrl);
			void vscode.window.showInformationMessage('URL do Gist copiada para a área de transferência.');
		} else {
			void vscode.window.showWarningMessage('Nenhum Gist registrado ainda. Conecte-se para sincronizar.');
		}
	}

	async openGist() {
		const lastSync = this.getLastSync();
		if (lastSync && lastSync.gistUrl) {
			await vscode.env.openExternal(vscode.Uri.parse(lastSync.gistUrl));
		} else {
			void vscode.window.showWarningMessage('Nenhum Gist registrado ainda.');
		}
	}

	async toggleAutoSync() {
		const current = this.isAutoSyncEnabled();
		await vscode.workspace.getConfiguration('agentecode.sync').update(
			'auto',
			!current,
			vscode.ConfigurationTarget.Global
		);
		const statusText = !current ? 'ativada' : 'desativada';
		void vscode.window.showInformationMessage(`Sincronização automática ${statusText}.`);
	}

	async toggleClaudeSync() {
		const enabled = this.isClaudeSyncEnabled();
		if (!enabled) {
			const choice = await vscode.window.showInformationMessage(
				'Sincronizar também a configuração do Claude?',
				{
					modal: true,
					detail: 'Serão enviados ao seu Gist secreto: o CLAUDE.md global e os arquivos de ~/.claude/commands, agents e skills (somente texto, até 200 KB cada). ' +
						'Login, histórico de conversas e settings.json do Claude nunca são enviados, e arquivos com chaves ou tokens são pulados. ' +
						'Lembre-se: quem tiver o link do Gist secreto consegue ler o conteúdo, então não deixe nada confidencial nesses arquivos.'
				},
				'Ligar'
			);
			if (choice !== 'Ligar') {
				return;
			}
		}
		await vscode.workspace.getConfiguration('agentecode.sync').update('syncClaudeConfig', !enabled, vscode.ConfigurationTarget.Global);
		void vscode.window.showInformationMessage(`Sincronização da configuração do Claude ${!enabled ? 'ligada' : 'desligada'}.`);
	}

	async disconnect() {
		const choice = await vscode.window.showWarningMessage(
			'Deseja realmente desconectar? O token de acesso será removido do AgenteCode. O Gist no GitHub será mantido.',
			{ modal: true },
			'Desconectar'
		);
		if (choice !== 'Desconectar') {
			return;
		}

		await this.deleteStoredToken();
		await this.setLastSync(null);
		await this.setUserLogin('');
		ui.updateStatusBar(this.statusBar, 'idle');
		void vscode.window.showInformationMessage('Desconectado do GitHub com sucesso.');
	}

	/**
	 * Verificacao inteligente ao iniciar (Fase 3): 10s apos startup, checa ETag no GitHub.
	 */
	setupStartupCheck() {
		const checkEnabled = vscode.workspace.getConfiguration('agentecode.sync').get('checkOnStartup', true);
		if (!checkEnabled) {
			return;
		}

		setTimeout(async () => {
			try {
				const token = await this.getStoredToken();
				const lastSync = this.getLastSync();
				if (!token || !lastSync || !lastSync.gistId) {
					return;
				}

				this.log.info('Verificação ao iniciar: consultando se há novidades no Gist...');
				const result = await gistClient.getGist(token, lastSync.gistId, {
					etag: lastSync.etag
				});

				if (result.notModified) {
					this.log.info('Gist não modificado (HTTP 304). Tudo atualizado.');
					return;
				}

				if (result.gist && result.gist.updated_at !== lastSync.remoteUpdatedAt) {
					// A data do Gist muda mesmo com conteúdo igual (ex.: após um envio deste computador);
					// só avisa quando o conteúdo remoto é realmente diferente do último sincronizado.
					const remoteData = snapshot.parseRemoteGistFiles(result.gist.files);
					const remoteHash = plan.computeRemoteCompositeHash(remoteData.files, remoteData.manifest);
					if (!plan.hasRemoteChanged(lastSync, remoteHash, result.gist.updated_at)) {
						this.log.info('Gist com data nova, mas conteúdo igual ao último sincronizado. Sem aviso.');
						await this.setLastSync({
							...lastSync,
							remoteUpdatedAt: result.gist.updated_at,
							etag: result.etag
						});
						return;
					}
					const choice = await vscode.window.showInformationMessage(
						'Há configurações mais novas no GitHub prontas para download.',
						'Ver mudanças',
						'Agora não'
					);
					if (choice === 'Ver mudanças') {
						await this.downloadFromGitHub();
					}
				}
			} catch (err) {
				this.log.warn('Falha na verificação de inicialização (silenciosa):', err.message);
			}
		}, 10000);
	}

	/**
	 * Observadores de arquivos com debounce para sincronizacao automatica (Fase 3).
	 */
	setupFileWatchers() {
		const userPattern = new vscode.RelativePattern(this.userDir, '{settings.json,keybindings.json,snippets/*}');
		const watcher = vscode.workspace.createFileSystemWatcher(userPattern);

		const scheduleAutoSync = () => {
			if (!this.isAutoSyncEnabled() || this.isSyncing) {
				return;
			}
			const delaySeconds = vscode.workspace.getConfiguration('agentecode.sync').get('autoDelaySeconds', 30);

			if (this.autoSyncTimer) {
				clearTimeout(this.autoSyncTimer);
			}

			this.autoSyncTimer = setTimeout(async () => {
				try {
					const token = await this.getStoredToken();
					if (!token) {
						return;
					}

					// Confere se o compositeHash local realmente mudou em relacao ao ultimo envio
					const lastSync = this.getLastSync();
					const localSnap = await snapshot.createLocalSnapshot({
						userDir: this.userDir,
						readFile: p => fs.promises.readFile(p, 'utf8').catch(() => null),
						readDir: d => fs.promises.readdir(d).catch(() => []),
						customExclusions: this.getCustomExclusions(),
						claudeDir: this._claudeDirIfEnabled()
					});

					if (lastSync && lastSync.localHash === localSnap.compositeHash) {
						return; // Conteudo nao mudou (ex.: toque apenas em metadata ou comentario ignorado)
					}

					this.log.info('Mudança detectada nas configurações locais. Disparando envio automático...');
					ui.updateStatusBar(this.statusBar, 'syncing');
					const outcome = await this._uploadWithToken(token, 'Envio automático', { auto: true });
					if (outcome === 'blocked') {
						ui.updateStatusBar(this.statusBar, 'conflict');
						void vscode.window.showWarningMessage('A sincronização automática foi pausada: as configurações mudaram aqui e no GitHub. Abra o menu de sincronização para resolver.');
					} else if (outcome === 'notifyDownload') {
						ui.updateStatusBar(this.statusBar, 'idle');
					} else {
						ui.updateStatusBar(this.statusBar, 'synced');
					}
				} catch (err) {
					this.log.warn('Falha no envio automático:', err.message);
					ui.updateStatusBar(this.statusBar, 'idle');
				}
			}, Math.max(10, delaySeconds) * 1000);
		};

		const claudeWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.claudeDir, '{CLAUDE.md,commands/**,agents/**,skills/**}')
		);
		const scheduleClaudeSync = () => {
			if (this.isClaudeSyncEnabled()) {
				scheduleAutoSync();
			}
		};
		claudeWatcher.onDidChange(scheduleClaudeSync);
		claudeWatcher.onDidCreate(scheduleClaudeSync);
		claudeWatcher.onDidDelete(scheduleClaudeSync);
		this.context.subscriptions.push(claudeWatcher);

		watcher.onDidChange(scheduleAutoSync);
		watcher.onDidCreate(scheduleAutoSync);
		watcher.onDidDelete(scheduleAutoSync);
		this.context.subscriptions.push(watcher);
	}
}

module.exports = {
	SyncController
};
