/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Hook "Stop" do Claude Code que avisa a IDE quando o Claude termina uma resposta. O hook roda um pequeno script que
// grava ~/.agentecode/claude-done.json (horario, pasta de trabalho e sessao); a IDE observa esse arquivo e traz a janela
// para a frente conforme a configuracao agentecode.focusWhenDone. Esta parte (alterar o settings.json) nao depende do editor.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT_NAME = 'claude-done.js';
const SIGNAL_NAME = 'claude-done.json';

/** Conteudo do script que o Claude Code executa no fim de cada resposta. */
const HOOK_SCRIPT = `'use strict';
// Gerado pelo AgenteCode. Avisa a IDE que o Claude terminou uma resposta.
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
	let data = {};
	try { data = JSON.parse(input); } catch { }
	const fs = require('fs');
	const path = require('path');
	const dir = path.join(require('os').homedir(), '.agentecode');
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, '${SIGNAL_NAME}'), JSON.stringify({ t: Date.now(), cwd: data.cwd || '', session: data.session_id || '' }));
	} catch { }
});
`;

/** @returns {string} pasta ~/.agentecode */
function agentecodeDir(home = os.homedir()) {
	return path.join(home, '.agentecode');
}

/** @returns {string} comando gravado no settings.json (barras normais funcionam no Git Bash do Windows e no Linux) */
function hookCommand(home = os.homedir()) {
	return `node "${path.join(agentecodeDir(home), SCRIPT_NAME).replace(/\\/g, '/')}"`;
}

/** @param {any} entry */
function isOurs(entry) {
	return Array.isArray(entry && entry.hooks) && entry.hooks.some(h => h && typeof h.command === 'string' && h.command.includes(SCRIPT_NAME));
}

/**
 * @param {any} settings
 * @returns {boolean}
 */
function hasStopHook(settings) {
	const stop = settings && settings.hooks && settings.hooks.Stop;
	return Array.isArray(stop) && stop.some(isOurs);
}

/**
 * Devolve uma copia do settings com o hook Stop do AgenteCode (sem duplicar, sem tocar nos outros hooks).
 * @param {any} settings
 * @param {string} command
 */
function withStopHook(settings, command) {
	const next = { ...(settings || {}) };
	const hooks = { ...(next.hooks || {}) };
	const stop = Array.isArray(hooks.Stop) ? hooks.Stop.filter(entry => !isOurs(entry)) : [];
	stop.push({ hooks: [{ type: 'command', command }] });
	hooks.Stop = stop;
	next.hooks = hooks;
	return next;
}

/**
 * Devolve uma copia do settings sem o hook Stop do AgenteCode (remove `hooks.Stop`/`hooks` se ficarem vazios).
 * @param {any} settings
 */
function withoutStopHook(settings) {
	const next = { ...(settings || {}) };
	if (!next.hooks || !Array.isArray(next.hooks.Stop)) {
		return next;
	}
	const hooks = { ...next.hooks };
	const stop = hooks.Stop.filter(entry => !isOurs(entry));
	if (stop.length > 0) {
		hooks.Stop = stop;
	} else {
		delete hooks.Stop;
	}
	if (Object.keys(hooks).length > 0) {
		next.hooks = hooks;
	} else {
		delete next.hooks;
	}
	return next;
}

/** @returns {string} caminho do settings.json do Claude Code */
function claudeSettingsPath(home = os.homedir()) {
	return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
}

/**
 * Le o settings.json. Arquivo inexistente vale como vazio; JSON invalido lanca erro (para nunca sobrescrever algo ilegivel).
 * @param {string} file
 */
function readSettings(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (err && err.code === 'ENOENT') {
			return {};
		}
		throw err;
	}
	if (!raw.trim()) {
		return {};
	}
	return JSON.parse(raw);
}

/**
 * Grava o settings.json guardando antes uma copia do original ao lado.
 * @param {string} file
 * @param {any} settings
 */
function writeSettings(file, settings) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (fs.existsSync(file)) {
		fs.copyFileSync(file, `${file}.agentecode-backup`);
	}
	fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/**
 * Instala: grava o script em ~/.agentecode e inclui o hook Stop no settings.json do Claude Code.
 * @param {{ home?: string, settingsFile?: string }} [options]
 * @returns {{ alreadyInstalled: boolean, settingsFile: string, command: string }}
 */
function installHook(options = {}) {
	const home = options.home || os.homedir();
	const settingsFile = options.settingsFile || claudeSettingsPath(home);
	const command = hookCommand(home);
	const settings = readSettings(settingsFile);
	fs.mkdirSync(agentecodeDir(home), { recursive: true });
	fs.writeFileSync(path.join(agentecodeDir(home), SCRIPT_NAME), HOOK_SCRIPT, 'utf8');
	const alreadyInstalled = hasStopHook(settings) && JSON.stringify(settings.hooks.Stop.filter(isOurs)) === JSON.stringify([{ hooks: [{ type: 'command', command }] }]);
	if (!alreadyInstalled) {
		writeSettings(settingsFile, withStopHook(settings, command));
	}
	return { alreadyInstalled, settingsFile, command };
}

/**
 * Remove o hook do settings.json (o script e o arquivo de aviso em ~/.agentecode tambem saem).
 * @param {{ home?: string, settingsFile?: string }} [options]
 * @returns {{ wasInstalled: boolean, settingsFile: string }}
 */
function removeHook(options = {}) {
	const home = options.home || os.homedir();
	const settingsFile = options.settingsFile || claudeSettingsPath(home);
	const settings = readSettings(settingsFile);
	const wasInstalled = hasStopHook(settings);
	if (wasInstalled) {
		writeSettings(settingsFile, withoutStopHook(settings));
	}
	for (const name of [SCRIPT_NAME, SIGNAL_NAME]) {
		try {
			fs.rmSync(path.join(agentecodeDir(home), name), { force: true });
		} catch {
			// nada a remover
		}
	}
	return { wasInstalled, settingsFile };
}

/** @returns {boolean} o `node` esta disponivel para o hook? */
function nodeAvailable() {
	try {
		return require('child_process').spawnSync('node', ['--version'], { timeout: 5000, shell: process.platform === 'win32' }).status === 0;
	} catch {
		return false;
	}
}

/** @param {import('vscode').ExtensionContext} context */
function registerDoneHook(context) {
	const vscode = require('vscode');
	const { t } = require('./i18n');
	context.subscriptions.push(
		vscode.commands.registerCommand('agentecode.focusWhenDone.installHook', async (alreadyAsked) => {
			const settingsFile = claudeSettingsPath();
			const confirm = t('Install');
			// quando vem do aviso da IDE, o usuario ja concordou ali
			const choice = alreadyAsked === true ? confirm : await vscode.window.showInformationMessage(
				t('Add a Stop hook to the Claude Code settings ({0})? It runs a tiny script when Claude finishes a response, which tells this IDE so it can come to the front. A backup of the file is kept next to it.', settingsFile),
				{ modal: true },
				confirm
			);
			if (choice !== confirm) {
				return;
			}
			try {
				const result = installHook();
				const warning = nodeAvailable() ? '' : ' ' + t('Node.js was not found on this computer; the hook needs it to run.');
				void vscode.window.showInformationMessage(
					(result.alreadyInstalled ? t('The hook was already installed.') : t('Hook installed. Start a new Claude Code conversation (or restart it) for it to take effect.')) + warning
				);
				if (vscode.workspace.getConfiguration('agentecode').get('focusWhenDone') === 'off') {
					const enable = t('Choose what happens');
					const next = await vscode.window.showInformationMessage(t('The option to react when Claude finishes is off. Choose what the IDE should do.'), enable);
					if (next === enable) {
						void vscode.commands.executeCommand('agentecode.focusWhenDone.choose');
					}
				}
			} catch (err) {
				void vscode.window.showErrorMessage(t('Could not change the Claude Code settings: {0}', err && err.message ? err.message : String(err)));
			}
		}),
		vscode.commands.registerCommand('agentecode.focusWhenDone.removeHook', async () => {
			try {
				const result = removeHook();
				void vscode.window.showInformationMessage(result.wasInstalled ? t('Hook removed.') : t('The hook was not installed.'));
			} catch (err) {
				void vscode.window.showErrorMessage(t('Could not change the Claude Code settings: {0}', err && err.message ? err.message : String(err)));
			}
		})
	);
}

module.exports = {
	HOOK_SCRIPT,
	hookCommand,
	hasStopHook,
	withStopHook,
	withoutStopHook,
	claudeSettingsPath,
	readSettings,
	installHook,
	removeHook,
	registerDoneHook
};
