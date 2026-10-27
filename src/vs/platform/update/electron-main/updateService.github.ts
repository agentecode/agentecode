/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

import { spawn } from 'child_process';
import { mkdir, readdir, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { transform } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { checksum } from '../../../base/node/crypto.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { IFileService } from '../../files/common/files.js';
import { ILifecycleMainService, LifecycleMainPhase } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, asTextOrError, IRequestService } from '../../request/common/request.js';
import { DisablementReason, IUpdateService, State, StateType, UpdateType } from '../common/update.js';
import { buildInstallerArgs, IGitHubRelease, IGitHubUpdate, INSTALL_HELPER_SCRIPT, parseChecksum, parseVersion, pickInstallerUrl, releaseFromLatestLocation, toUpdate } from '../common/githubRelease.js';

const REPOSITORY = 'agentecode/agentecode';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
/** Redireciona para a página da última Release estável; ao contrário da API, não tem o limite de 60 consultas por hora. */
const LATEST_RELEASE_PAGE_URL = `https://github.com/${REPOSITORY}/releases/latest`;
/** Variável de ambiente que troca a URL consultada, para testar o aviso sem publicar uma Release. */
const UPDATE_URL_OVERRIDE_ENV = 'AGENTECODE_UPDATE_URL';
/** Com valor, o botão "Restart to Update" só registra no log o que faria, sem executar o instalador nem fechar a IDE. */
const UPDATE_DRY_RUN_ENV = 'AGENTECODE_UPDATE_DRYRUN';
/** Com valor, baixa a atualização assim que ela é encontrada, sem esperar o clique no menu (para testes). */
const UPDATE_AUTO_DOWNLOAD_ENV = 'AGENTECODE_UPDATE_AUTODOWNLOAD';
/** Intervalo mínimo entre atualizações da barra de progresso do download. */
const PROGRESS_INTERVAL = 500;
const FIRST_CHECK_DELAY = 30 * 1000;
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

// allow-any-unicode-next-line
const ERR_CHECKSUM_FILE = 'O arquivo de verificação (.sha256) da Release está inválido.';
// allow-any-unicode-next-line
const ERR_HASH_MISMATCH = 'A verificação de integridade falhou: o arquivo baixado não confere com o SHA-256 da Release.';
// allow-any-unicode-next-line
const errServerStatus = (status: number | undefined) => `O servidor respondeu ${status} ao baixar o instalador.`;
// allow-any-unicode-next-line
const MSG_CHECK_FAILED = 'Não foi possível verificar atualizações agora. Tente novamente em alguns minutos.';
// allow-any-unicode-next-line
const MSG_AUTO_UPDATE_UNAVAILABLE = 'A atualização automática não funcionou.';
// allow-any-unicode-next-line
const MSG_DOWNLOAD_FAILED = 'Não foi possível baixar a atualização dentro da IDE.';
// allow-any-unicode-next-line
const MSG_NO_INSTALLER = 'O instalador desta versão ainda não está disponível para atualização automática. Você pode baixá-lo pelo site.';
// allow-any-unicode-next-line
const BUTTON_OPEN_PAGE = 'Baixar pelo site';
// allow-any-unicode-next-line
const BUTTON_CANCEL = 'Cancelar';

/**
 * Serviço de atualização do AgenteCode: consulta a última Release estável no GitHub e, havendo versão
 * maior, entra em `AvailableForDownload`. A interface (item "Check for Updates..." e marcador na
 * engrenagem) é a mesma do VS Code, guiada por este estado.
 *
 * No Windows, "Download Update" baixa o instalador dentro da IDE (com progresso), confere o SHA-256 contra o
 * arquivo `.sha256` da Release e passa para `Ready` ("Restart to Update"). Esse botão fecha a IDE de forma
 * normal, executa o instalador quando o processo terminou e a nova versão abre sozinha. Se algo falhar, ou
 * em outras plataformas, abre a página da Release no navegador.
 *
 * Respeita `update.mode`: `none` desliga tudo, `manual` só verifica sob demanda, `start` verifica uma
 * vez ao abrir e `default` verifica ao abrir e a cada 24 h.
 */
export class GitHubUpdateService extends Disposable implements IUpdateService {

	declare readonly _serviceBrand: undefined;

	private _state: State = State.Uninitialized;
	private readonly _onStateChange = this._register(new Emitter<State>());
	readonly onStateChange: Event<State> = this._onStateChange.event;

	private readonly firstCheckTimer = this._register(new MutableDisposable());
	private readonly intervalTimer = this._register(new MutableDisposable());

	/** Atualização encontrada na última verificação. */
	private pending: IGitHubUpdate | undefined;
	/** Instalador baixado e com o hash conferido. */
	private installerPath: string | undefined;

	get state(): State {
		return this._state;
	}

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@INativeHostMainService private readonly nativeHostMainService: INativeHostMainService,
		@IProductService private readonly productService: IProductService,
		@IFileService private readonly fileService: IFileService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
	) {
		super();

		this.lifecycleMainService.when(LifecycleMainPhase.AfterWindowOpen).then(() => this.configure());
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('update.mode')) {
				this.configure();
			}
		}));
	}

	/** Versão instalada, lida do `nameLong` do produto (ex.: "Agente Code IDE v1.0.0"). */
	private get currentVersion(): string | undefined {
		return parseVersion(this.productService.nameLong)?.join('.');
	}

	private setState(state: State): void {
		this.logService.info('update#setState', state.type);
		this._state = state;
		this._onStateChange.fire(state);
	}

	private configure(): void {
		const mode = this.configurationService.getValue<string>('update.mode');
		this.firstCheckTimer.clear();
		this.intervalTimer.clear();

		if (mode === 'none') {
			this.setState(State.Disabled(DisablementReason.ManuallyDisabled));
			return;
		}
		if (!this.currentVersion) {
			// Build de desenvolvimento, sem versão no nome do produto: não há com o que comparar.
			this.setState(State.Disabled(DisablementReason.NotBuilt));
			return;
		}
		if (this._state.type === StateType.Uninitialized || this._state.type === StateType.Disabled) {
			this.setState(State.Idle(UpdateType.Setup));
		}
		if (mode === 'manual') {
			return;
		}

		const timer = setTimeout(() => {
			this.checkForUpdates(false);
			if (mode !== 'start') {
				const interval = setInterval(() => this.checkForUpdates(false), CHECK_INTERVAL);
				this.intervalTimer.value = { dispose: () => clearInterval(interval) };
			}
		}, FIRST_CHECK_DELAY);
		this.firstCheckTimer.value = { dispose: () => clearTimeout(timer) };
	}

	async checkForUpdates(explicit: boolean): Promise<void> {
		const type = this._state.type;
		if (type !== StateType.Idle && type !== StateType.AvailableForDownload) {
			return;
		}
		if (type === StateType.AvailableForDownload && !explicit) {
			return;
		}

		this.setState(State.CheckingForUpdates(explicit));
		try {
			const release = await this.fetchLatestRelease();
			const update = release ? toUpdate(release, this.currentVersion, process.platform) : undefined;

			if (update) {
				this.pending = update;
				this.setState(State.AvailableForDownload(update));
				if (process.env[UPDATE_AUTO_DOWNLOAD_ENV]) {
					void this.downloadUpdate(false);
				}
			} else {
				this.pending = undefined;
				this.setState(State.Idle(UpdateType.Setup, undefined, explicit || undefined));
			}
		} catch (error) {
			this.logService.error('update#checkForUpdates(): failed to query GitHub', error);
			// Verificação automática falha em silêncio; só quem clicou em "Check for Updates" recebe um aviso, sem detalhe técnico.
			this.setState(State.Idle(UpdateType.Setup, explicit ? MSG_CHECK_FAILED : undefined));
		}
	}

	/**
	 * Última Release estável, ou `undefined` se não houver (ou se o instalador ainda não foi anexado).
	 * Primeiro pela página do github.com, que não tem o limite de 60 consultas por hora da API; se isso falhar,
	 * pela API.
	 */
	private async fetchLatestRelease(): Promise<IGitHubRelease | undefined> {
		const override = process.env[UPDATE_URL_OVERRIDE_ENV];
		if (!override) {
			try {
				return await this.fetchLatestReleaseFromWeb();
			} catch (error) {
				this.logService.warn('update#fetchLatestRelease(): github.com failed, trying the API', error instanceof Error ? error.message : String(error));
			}
		}
		const context = await this.requestService.request({
			url: override || LATEST_RELEASE_URL,
			headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': `AgenteCode/${this.currentVersion}` },
			callSite: 'updateService.github',
		}, CancellationToken.None);

		// 404: o repositório ainda não tem Release estável (pré-lançamentos não contam em /releases/latest).
		return context.res.statusCode === 404 ? undefined : (await asJson<IGitHubRelease>(context)) ?? undefined;
	}

	private async fetchLatestReleaseFromWeb(): Promise<IGitHubRelease | undefined> {
		const headers = { 'User-Agent': `AgenteCode/${this.currentVersion}` };
		const latest = await this.requestService.request({ url: LATEST_RELEASE_PAGE_URL, headers, followRedirects: 0, callSite: 'updateService.github.web' }, CancellationToken.None);
		const status = latest.res.statusCode;
		if (status === 404) {
			return undefined;
		}
		const location = latest.res.headers.location;
		const release = status !== undefined && status >= 300 && status < 400 ? releaseFromLatestLocation(Array.isArray(location) ? location[0] : location, REPOSITORY) : undefined;
		if (!release) {
			throw new Error(`unexpected response ${status} from ${LATEST_RELEASE_PAGE_URL}`);
		}

		// o instalador pode ainda não ter sido anexado (o build do Windows termina depois do Linux): sem ele, não há atualização por enquanto
		const installerUrl = pickInstallerUrl(release, process.platform);
		if (installerUrl) {
			const head = await this.requestService.request({ type: 'HEAD', url: installerUrl, headers, followRedirects: 0, callSite: 'updateService.github.web.asset' }, CancellationToken.None);
			if (head.res.statusCode === 404) {
				return undefined;
			}
			if (!head.res.statusCode || head.res.statusCode >= 400) {
				throw new Error(`unexpected response ${head.res.statusCode} from ${installerUrl}`);
			}
		}
		return release;
	}

	async downloadUpdate(explicit: boolean): Promise<void> {
		if (this._state.type !== StateType.AvailableForDownload || !this.pending) {
			return;
		}
		const update = this.pending;

		if (!this.canInstallInApp(update)) {
			if (process.platform === 'win32') {
				// no Windows o normal é baixar e instalar dentro da IDE; sem instalador na Release, só oferece o site
				await this.offerReleasePage(update, MSG_NO_INSTALLER);
			} else {
				await this.openReleasePage(update);
			}
			return;
		}

		const startTime = Date.now();
		this.setState(State.Downloading(update, explicit, false, 0, undefined, startTime));
		try {
			this.installerPath = await this.downloadInstaller(update, explicit, startTime);
			this.setState(State.Ready(update, explicit, false));
		} catch (error) {
			this.logService.error('update#downloadUpdate(): failed', error);
			this.installerPath = undefined;
			this.setState(State.AvailableForDownload(update));
			await this.offerReleasePage(update, `${MSG_DOWNLOAD_FAILED}\n\n${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Só depois que o automático falha: pergunta se o usuário quer baixar o instalador pelo site. */
	private async offerReleasePage(update: IGitHubUpdate, detail: string): Promise<void> {
		const { response } = await this.dialogMainService.showMessageBox({
			type: 'warning',
			message: MSG_AUTO_UPDATE_UNAVAILABLE,
			detail,
			buttons: [BUTTON_OPEN_PAGE, BUTTON_CANCEL],
			defaultId: 0,
			cancelId: 1,
		});
		if (response === 0) {
			await this.openReleasePage(update);
		}
	}

	/** O download dentro da IDE só vale no Windows e quando a Release traz o instalador e o arquivo de hash. */
	private canInstallInApp(update: IGitHubUpdate): boolean {
		return process.platform === 'win32' && !!update.sha256Url && /\.exe$/i.test(update.url ?? '');
	}

	private async openReleasePage(update: IGitHubUpdate): Promise<void> {
		const url = update.releaseUrl ?? update.url;
		if (url) {
			await this.nativeHostMainService.openExternal(undefined, url);
		}
	}

	/** Baixa o instalador para uma pasta temporária, confere o SHA-256 e devolve o caminho do arquivo. */
	private async downloadInstaller(update: IGitHubUpdate, explicit: boolean, startTime: number): Promise<string> {
		const expectedHash = parseChecksum(await asTextOrError(await this.requestService.request({ url: update.sha256Url!, callSite: 'updateService.github.checksum' }, CancellationToken.None)));
		if (!expectedHash) {
			throw new Error(ERR_CHECKSUM_FILE);
		}

		const dir = path.join(tmpdir(), 'AgenteCode-update');
		await mkdir(dir, { recursive: true });
		for (const name of await readdir(dir)) {
			await rm(path.join(dir, name), { recursive: true, force: true });
		}
		const installerPath = path.join(dir, `AgenteCodeSetup-x64-${update.version}.exe`);
		const downloadPath = `${installerPath}.tmp`;

		const context = await this.requestService.request({ url: update.url!, callSite: 'updateService.github.download' }, CancellationToken.None);
		if (context.res.statusCode !== 200) {
			throw new Error(errServerStatus(context.res.statusCode));
		}
		const lengthHeader = context.res.headers['content-length'];
		const totalBytes = typeof lengthHeader === 'string' ? parseInt(lengthHeader, 10) : undefined;

		// Progress is throttled (at most one update every 500 ms). A debounce (Delayer) would never fire while
		// data keeps arriving, leaving the progress bar frozen until the download ends.
		let downloadedBytes = 0;
		let lastProgressUpdate = 0;
		const progressStream = transform<VSBuffer, VSBuffer>(
			context.stream,
			{
				data: data => {
					downloadedBytes += data.byteLength;
					const now = Date.now();
					if (now - lastProgressUpdate >= PROGRESS_INTERVAL) {
						lastProgressUpdate = now;
						this.setState(State.Downloading(update, explicit, false, downloadedBytes, totalBytes, startTime));
					}
					return data;
				}
			},
			chunks => VSBuffer.concat(chunks)
		);

		try {
			await this.fileService.writeFile(URI.file(downloadPath), progressStream);
			await checksum(downloadPath, expectedHash).catch(error => {
				throw new Error(error instanceof Error && error.message === 'Hash mismatch'
					? ERR_HASH_MISMATCH
					: String(error));
			});
			await rename(downloadPath, installerPath);
		} catch (error) {
			await rm(downloadPath, { force: true });
			throw error;
		}
		return installerPath;
	}

	async applyUpdate(): Promise<void> {
		// A instalação acontece em quitAndInstall(), depois que a IDE fecha.
	}

	async quitAndInstall(): Promise<void> {
		if (this._state.type !== StateType.Ready || !this.installerPath) {
			return;
		}
		const update = this._state.update;

		const dir = path.dirname(this.installerPath);
		const helperPath = path.join(dir, 'install-helper.js');
		const helperArgs = [
			helperPath,
			String(process.pid),
			path.join(dir, 'helper.log'),
			process.execPath,
			this.installerPath,
			...buildInstallerArgs(path.join(dir, 'install.log')),
		];

		if (process.env[UPDATE_DRY_RUN_ENV]) {
			this.logService.info(`update#quitAndInstall (dry run): ${process.execPath} ${helperArgs.join(' ')}`);
			return;
		}

		// O auxiliar espera esta IDE terminar antes de executar o instalador; assim o instalador nunca encontra a IDE aberta.
		// É o próprio executável da IDE em modo Node (programa gráfico): PowerShell ou cmd, sendo programas de console,
		// não iniciam quando criados assim (erro 0xC0000142).
		await writeFile(helperPath, INSTALL_HELPER_SCRIPT);
		const child = spawn(process.execPath, helperArgs, {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
		});
		child.once('error', error => this.logService.error('update#quitAndInstall(): failed to start the installer helper', error));
		child.unref();

		this.setState(State.Restarting(update));
		const vetoed = await this.lifecycleMainService.quit();
		if (vetoed) {
			// O usuário cancelou o fechamento (por exemplo, para salvar algo): não instala com a IDE aberta.
			child.kill();
			this.setState(State.Ready(update, true, false));
		}
	}

	async isLatestVersion(): Promise<boolean | undefined> {
		return this._state.type === StateType.AvailableForDownload ? false : undefined;
	}

	async _applySpecificUpdate(_packagePath: string): Promise<void> {
		// sem uso
	}

	async setInternalOrg(_internalOrg: string | undefined): Promise<void> {
		// sem uso
	}
}
