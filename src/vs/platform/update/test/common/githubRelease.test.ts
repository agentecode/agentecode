/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildInstallerArgs, IGitHubRelease, INSTALL_HELPER_SCRIPT, isNewerVersion, parseChecksum, parseVersion, pickChecksumUrl, pickDownloadUrl, pickInstallerUrl, releaseFromLatestLocation, toUpdate } from '../../common/githubRelease.js';

suite('GitHub release helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const release: IGitHubRelease = {
		tag_name: 'v1.2.0',
		html_url: 'https://github.com/agentecode/agentecode/releases/tag/v1.2.0',
		published_at: '2026-10-20T12:00:00Z',
		assets: [
			{ name: 'AgenteCodeSetup-x64-v1.2.0.exe.sha256', browser_download_url: 'https://example.test/setup.exe.sha256' },
			{ name: 'AgenteCodeSetup-x64-v1.2.0.exe', browser_download_url: 'https://example.test/setup.exe' },
			{ name: 'agentecode_1.2.0_amd64.deb', browser_download_url: 'https://example.test/pkg.deb' },
		]
	};

	test('parseVersion', () => {
		assert.deepStrictEqual(
			[parseVersion('Agente Code IDE v1.0.0'), parseVersion('v0.0.6-test'), parseVersion('sem versão')],
			[[1, 0, 0], [0, 0, 6], undefined]
		);
	});

	test('isNewerVersion compara numericamente e ignora versões ilegíveis', () => {
		assert.deepStrictEqual(
			[
				isNewerVersion('1.0.0', 'v1.0.1'),
				isNewerVersion('1.9.0', 'v1.10.0'),
				isNewerVersion('1.0.0', 'v1.0.0'),
				isNewerVersion('1.2.0', 'v1.1.9'),
				isNewerVersion('1.0.0', 'latest'),
				isNewerVersion(undefined, 'v2.0.0'),
			],
			[true, true, false, false, false, false]
		);
	});

	test('pickDownloadUrl escolhe o instalador da plataforma', () => {
		assert.deepStrictEqual(
			[pickDownloadUrl(release, 'win32'), pickDownloadUrl(release, 'linux'), pickDownloadUrl(release, 'darwin')],
			['https://example.test/setup.exe', 'https://example.test/pkg.deb', release.html_url]
		);
	});

	test('pickChecksumUrl só devolve o .sha256 do instalador da plataforma', () => {
		assert.deepStrictEqual(
			[pickChecksumUrl(release, 'win32'), pickChecksumUrl(release, 'linux'), pickChecksumUrl({ assets: [release.assets![1]] }, 'win32')],
			['https://example.test/setup.exe.sha256', undefined, undefined]
		);
	});

	test('parseChecksum lê o formato "hash  nome" e recusa o resto', () => {
		const hash = 'a'.repeat(64);
		assert.deepStrictEqual(
			[parseChecksum(`${hash.toUpperCase()}  AgenteCodeSetup-x64-v1.exe\n`), parseChecksum(hash), parseChecksum('abc  x'), parseChecksum(`<html>${hash}`), parseChecksum(null)],
			[hash, hash, undefined, undefined, undefined]
		);
	});

	test('buildInstallerArgs: silencioso, sem reiniciar o Windows, reabre a IDE e grava log', () => {
		assert.deepStrictEqual(
			buildInstallerArgs(`C:\\Temp\\AgenteCode-update\\install.log`),
			['/SILENT', '/NORESTART', '/MERGETASKS=runcode,!desktopicon,!quicklaunchicon', `/LOG=C:\\Temp\\AgenteCode-update\\install.log`]
		);
	});

	test('INSTALL_HELPER_SCRIPT é JavaScript válido, não passa ELECTRON_RUN_AS_NODE ao instalador e reabre a IDE se falhar', () => {
		// só a sintaxe é verificada aqui; o comportamento foi exercitado com o executável da IDE em modo Node
		assert.doesNotThrow(() => new Function(INSTALL_HELPER_SCRIPT));
		assert.deepStrictEqual(
			[
				INSTALL_HELPER_SCRIPT.includes('delete cleanEnv.ELECTRON_RUN_AS_NODE'),
				INSTALL_HELPER_SCRIPT.includes('env: { ...cleanEnv, __COMPAT_LAYER: \'RunAsInvoker\' }'),
				INSTALL_HELPER_SCRIPT.includes('spawn(ideExe, [], { detached: true, stdio: \'ignore\', env: cleanEnv })'),
				/powershell|cmd\.exe/i.test(INSTALL_HELPER_SCRIPT),
			],
			[true, true, true, false]
		);
	});

	test('releaseFromLatestLocation monta a Release a partir do redirecionamento de /releases/latest', () => {
		const fromWeb = releaseFromLatestLocation('https://github.com/agentecode/agentecode/releases/tag/v1.0.12', 'agentecode/agentecode')!;
		assert.deepStrictEqual(
			[
				releaseFromLatestLocation('https://github.com/agentecode/agentecode/releases', 'agentecode/agentecode'),
				releaseFromLatestLocation(undefined, 'agentecode/agentecode'),
				fromWeb.tag_name,
				pickInstallerUrl(fromWeb, 'win32'),
				pickChecksumUrl(fromWeb, 'win32'),
				pickInstallerUrl(fromWeb, 'linux'),
				pickInstallerUrl(fromWeb, 'darwin'),
				toUpdate(fromWeb, '1.0.11', 'win32')?.version,
			],
			[
				undefined,
				undefined,
				'v1.0.12',
				'https://github.com/agentecode/agentecode/releases/download/v1.0.12/AgenteCodeSetup-x64-v1.0.12.exe',
				'https://github.com/agentecode/agentecode/releases/download/v1.0.12/AgenteCodeSetup-x64-v1.0.12.exe.sha256',
				'https://github.com/agentecode/agentecode/releases/download/v1.0.12/AgenteCode-linux-x64-v1.0.12.deb',
				undefined,
				'v1.0.12',
			]
		);
	});

	test('toUpdate só devolve quando a Release é mais nova', () => {
		assert.deepStrictEqual(toUpdate(release, '1.0.0', 'win32'), {
			version: 'v1.2.0',
			productVersion: '1.2.0',
			timestamp: Date.parse('2026-10-20T12:00:00Z'),
			url: 'https://example.test/setup.exe',
			releaseUrl: release.html_url,
			sha256Url: 'https://example.test/setup.exe.sha256',
		});
		assert.strictEqual(toUpdate(release, '1.2.0', 'win32'), undefined);
		assert.strictEqual(toUpdate({}, '1.0.0', 'win32'), undefined);
	});
});
