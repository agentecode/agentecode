/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

import { IUpdate } from './update.js';

/**
 * Subconjunto da resposta de `GET /repos/{owner}/{repo}/releases/latest` usado pelo AgenteCode.
 */
export interface IGitHubRelease {
	readonly tag_name?: string;
	readonly html_url?: string;
	readonly published_at?: string;
	readonly assets?: readonly { readonly name: string; readonly browser_download_url: string }[];
}

/**
 * Monta a Release a partir do endereço para onde `github.com/<repositório>/releases/latest` redireciona
 * (`.../releases/tag/v1.2.3`), sem usar a API do GitHub (que limita 60 consultas por hora por endereço).
 * Os anexos seguem os nomes fixos do workflow de release; quem chama confere se o instalador já existe.
 */
export function releaseFromLatestLocation(location: string | undefined, repository: string): IGitHubRelease | undefined {
	const tag = /\/releases\/tag\/(?<tag>v\d+\.\d+\.\d+[^/?#]*)$/.exec(location ?? '')?.groups?.tag;
	if (!tag) {
		return undefined;
	}
	const base = `https://github.com/${repository}/releases`;
	const asset = (name: string) => ({ name, browser_download_url: `${base}/download/${tag}/${name}` });
	return {
		tag_name: tag,
		html_url: `${base}/tag/${tag}`,
		assets: [
			asset(`AgenteCodeSetup-x64-${tag}.exe`),
			asset(`AgenteCodeSetup-x64-${tag}.exe.sha256`),
			asset(`AgenteCode-linux-x64-${tag}.deb`),
		]
	};
}

/**
 * Extrai `[major, minor, patch]` de textos como `v1.2.3`, `Agente Code IDE v1.0.0` ou `v0.0.6-test`.
 * Sufixos de pré-lançamento são ignorados.
 */
export function parseVersion(text: string | undefined): [number, number, number] | undefined {
	const match = /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/.exec(text ?? '');
	if (!match?.groups) {
		return undefined;
	}
	return [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch)];
}

/**
 * `true` se `latest` for maior que `current`. Versões ilegíveis nunca indicam atualização.
 */
export function isNewerVersion(current: string | undefined, latest: string | undefined): boolean {
	const a = parseVersion(current);
	const b = parseVersion(latest);
	if (!a || !b) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) {
			return b[i] > a[i];
		}
	}
	return false;
}

function pickInstallerAsset(release: IGitHubRelease, platform: string) {
	const pattern = platform === 'win32' ? /^AgenteCodeSetup-x64.*\.exe$/i : platform === 'linux' ? /\.deb$/i : undefined;
	return pattern ? release.assets?.find(a => pattern.test(a.name)) : undefined;
}

/**
 * Endereço do instalador da plataforma entre os anexos da Release, ou `undefined` se a plataforma não tem instalador.
 */
export function pickInstallerUrl(release: IGitHubRelease, platform: string): string | undefined {
	return pickInstallerAsset(release, platform)?.browser_download_url;
}

/**
 * Escolhe o instalador da plataforma entre os anexos da Release; sem correspondência, a página da Release.
 */
export function pickDownloadUrl(release: IGitHubRelease, platform: string): string | undefined {
	return pickInstallerAsset(release, platform)?.browser_download_url ?? release.html_url;
}

/**
 * URL do arquivo `<instalador>.sha256` anexado pelo workflow de release, quando existe.
 */
export function pickChecksumUrl(release: IGitHubRelease, platform: string): string | undefined {
	const installer = pickInstallerAsset(release, platform);
	return installer ? release.assets?.find(a => a.name === `${installer.name}.sha256`)?.browser_download_url : undefined;
}

/**
 * Lê o SHA-256 (64 caracteres hexadecimais) de um arquivo `.sha256` no formato "hash  nome".
 */
export function parseChecksum(text: string | null | undefined): string | undefined {
	const match = /^\s*(?<hash>[0-9a-fA-F]{64})(?:\s|$)/.exec(text ?? '');
	return match?.groups?.hash.toLowerCase();
}

/**
 * `IUpdate` com o que o AgenteCode precisa para baixar e instalar dentro da IDE.
 */
export interface IGitHubUpdate extends IUpdate {
	/** Página da Release, usada quando o download dentro da IDE não é possível. */
	readonly releaseUrl?: string;
	/** Arquivo `.sha256` anexado ao instalador. Sem ele, o download dentro da IDE não é usado. */
	readonly sha256Url?: string;
}

/**
 * Converte uma Release do GitHub em atualização, ou `undefined` quando ela não é mais nova que `currentVersion`.
 */
export function toUpdate(release: IGitHubRelease, currentVersion: string | undefined, platform: string): IGitHubUpdate | undefined {
	const tag = release.tag_name;
	if (!tag || !isNewerVersion(currentVersion, tag)) {
		return undefined;
	}
	const timestamp = release.published_at ? Date.parse(release.published_at) : NaN;
	return {
		version: tag,
		productVersion: parseVersion(tag)?.join('.'),
		timestamp: isNaN(timestamp) ? undefined : timestamp,
		url: pickDownloadUrl(release, platform),
		releaseUrl: release.html_url,
		sha256Url: pickChecksumUrl(release, platform),
	};
}

/**
 * Argumentos do instalador (Inno Setup): sem perguntas (a janela de progresso continua visível), sem reiniciar
 * o Windows, reabrindo a IDE no fim e gravando o log da instalação em `logPath`.
 */
export function buildInstallerArgs(logPath: string): string[] {
	return ['/SILENT', '/NORESTART', '/MERGETASKS=runcode,!desktopicon,!quicklaunchicon', `/LOG=${logPath}`];
}

/**
 * Programa auxiliar, em JavaScript, executado pelo próprio executável da IDE em modo Node (ELECTRON_RUN_AS_NODE).
 * Ele espera a IDE terminar e só então executa o instalador, de modo que o instalador nunca encontra a IDE aberta.
 *
 * Por que não PowerShell ou cmd: são programas de console, e criados sem janela e desligados da IDE o Windows
 * falha ao iniciá-los (erro 0xC0000142). O executável da IDE é um programa gráfico e não tem esse problema.
 *
 * Argumentos: pid da IDE, arquivo de log do auxiliar, executável da IDE, instalador e argumentos do instalador.
 * Se o instalador não iniciar, reabre a IDE atual para o usuário não ficar sem ela. O ambiente passado ao
 * instalador NÃO leva ELECTRON_RUN_AS_NODE, senão a IDE reaberta por ele subiria em modo Node.
 */
export const INSTALL_HELPER_SCRIPT = `
const { spawn } = require('child_process');
const fs = require('fs');
const [mainPid, logFile, ideExe, installer, ...installerArgs] = process.argv.slice(2);
const log = message => { try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + message + String.fromCharCode(10)); } catch { } };
const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const deadline = Date.now() + 300000;
function failed(error) {
	log('o instalador nao iniciou: ' + error.message + '; reabrindo a IDE atual');
	try { spawn(ideExe, [], { detached: true, stdio: 'ignore', env: cleanEnv }).unref(); } catch { }
	setTimeout(() => process.exit(1), 500);
}
log('auxiliar iniciou; esperando a IDE (pid ' + mainPid + ') terminar');
(function waitForIde() {
	if (alive(Number(mainPid)) && Date.now() < deadline) { setTimeout(waitForIde, 300); return; }
	log('a IDE terminou; executando o instalador');
	setTimeout(() => {
		let child;
		try {
			child = spawn(installer, installerArgs, { detached: true, stdio: 'ignore', env: { ...cleanEnv, __COMPAT_LAYER: 'RunAsInvoker' } });
		} catch (error) { failed(error); return; }
		child.once('error', failed);
		child.unref();
		setTimeout(() => { log('instalador iniciado (pid ' + child.pid + ')'); process.exit(0); }, 1500);
	}, 1500);
})();
`;
