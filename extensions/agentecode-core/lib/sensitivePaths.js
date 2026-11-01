/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { t } = require('./i18n');

/**
 * Arquivos que merecem mais atencao na revisao das mudancas do agente. Os padroes valem em qualquer pasta do projeto
 * (`.vscode/tasks.json` tambem casa em `app/.vscode/tasks.json`); `*` nao atravessa pastas, `**` atravessa.
 * A primeira categoria que casar vence.
 */
const RULES = [
	{
		kind: 'runs',
		patterns: [
			'.vscode/tasks.json', '.vscode/launch.json', '.vscode/settings.json',
			'.github/workflows/**', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile',
			'.husky/**', '.git/hooks/**',
			'.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/**',
			'package.json', 'Makefile', '*.ps1', '*.sh', '*.bat', '*.cmd'
		]
	},
	{
		kind: 'secrets',
		patterns: ['.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', 'id_rsa', 'id_ed25519', 'appsettings.*.json', 'secrets*', 'credentials*']
	},
	{
		kind: 'dependencies',
		patterns: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '*.csproj', 'Directory.Packages.props', 'packages.config', 'requirements.txt']
	}
];

/** @type {Map<string, RegExp>} */
const compiled = new Map();

/** Converte um padrao com `*`, `**` e `?` em expressao regular (sem diferenciar maiusculas, em qualquer pasta). */
function globToRegExp(glob) {
	let cached = compiled.get(glob);
	if (cached) {
		return cached;
	}
	let source = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				i++;
				if (glob[i + 1] === '/') {
					i++;
					source += '(?:.*/)?';
				} else {
					source += '.*';
				}
			} else {
				source += '[^/]*';
			}
		} else if (ch === '?') {
			source += '[^/]';
		} else {
			source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	cached = new RegExp(`^(?:.*/)?${source}$`, 'i');
	compiled.set(glob, cached);
	return cached;
}

/**
 * Categoria de sensibilidade de um arquivo, ou `undefined` se for comum.
 * @param {string} relativePath caminho relativo a pasta do projeto, com `/`
 * @param {string[]} [extraPatterns] padroes do usuario (categoria `custom`)
 * @returns {'runs' | 'secrets' | 'dependencies' | 'custom' | undefined}
 */
function sensitiveKind(relativePath, extraPatterns = []) {
	const normalized = relativePath.replace(/\\/g, '/');
	for (const rule of RULES) {
		if (rule.patterns.some(pattern => globToRegExp(pattern).test(normalized))) {
			return rule.kind;
		}
	}
	if (extraPatterns.some(pattern => typeof pattern === 'string' && pattern.trim() && globToRegExp(pattern.trim().replace(/\\/g, '/')).test(normalized))) {
		return 'custom';
	}
	return undefined;
}

/** Motivo da marca, no idioma atual (avaliado no uso, pois o idioma e definido depois dos require). */
function sensitiveReason(kind) {
	switch (kind) {
		case 'runs':
			return t('Can run commands on its own (editor tasks, CI, build scripts or git hooks).');
		case 'secrets':
			return t('May hold passwords or keys.');
		case 'dependencies':
			return t('Changes which packages the project uses.');
		default:
			return t('Marked as sensitive in your settings.');
	}
}

module.exports = { sensitiveKind, sensitiveReason };
