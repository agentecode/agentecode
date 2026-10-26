/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

/** Prefixo dos arquivos da configuracao do Claude dentro do Gist (Gists nao tem pastas). */
const CLAUDE_PREFIX = 'claude--';

/** Pastas de ~/.claude que entram na sincronizacao, alem do CLAUDE.md na raiz. */
const CLAUDE_DIRS = ['commands', 'agents', 'skills'];

/** Extensoes de texto aceitas. Nada binario e nada de credenciais (.credentials.json fica fora por estar na raiz). */
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.py', '.sh', '.js', '.ts', '.ps1']);

const MAX_FILES = 100;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 1500 * 1024;
const MAX_DEPTH = 6;

const JSON_SECRET_KEY = /"[^"]*(?:senha|segredo|credencia[il]|credential|passw(?:or)?d|private[_-]?key|api[_-]?key|access[_-]?key|token|secret)[^"]*"\s*:\s*"[^"]+"/i;

/**
 * Valida um caminho relativo (com '/') dentro de ~/.claude. Barra traversal, pastas ocultas e tipos nao permitidos.
 * @param {string} rel
 * @returns {boolean}
 */
function isValidClaudeRelPath(rel) {
	if (typeof rel !== 'string' || !rel || rel.length > 180 || rel.includes('\\')) {
		return false;
	}
	const parts = rel.split('/');
	if (parts.length > MAX_DEPTH) {
		return false;
	}
	for (const part of parts) {
		if (!part || part === '.' || part === '..' || part.startsWith('.') || !/^[A-Za-z0-9._ @+()-]+$/.test(part)) {
			return false;
		}
	}
	if (rel === 'CLAUDE.md') {
		return true;
	}
	if (parts.length < 2 || !CLAUDE_DIRS.includes(parts[0])) {
		return false;
	}
	return ALLOWED_EXTENSIONS.has(path.posix.extname(rel).toLowerCase());
}

/**
 * @param {string} rel
 * @returns {string}
 */
function toGistName(rel) {
	return CLAUDE_PREFIX + rel.replace(/\//g, '--');
}

/**
 * Indica se o conteudo parece ter segredos (mesmos padroes do filtro de configuracoes).
 * @param {string} rel
 * @param {string} content
 * @returns {boolean}
 */
function looksSensitive(rel, content) {
	for (const pattern of config.VALUE_SECRET_PATTERNS) {
		if (pattern.test(content)) {
			return true;
		}
	}
	return rel.toLowerCase().endsWith('.json') && JSON_SECRET_KEY.test(content);
}

/**
 * Lista recursivamente os arquivos de uma pasta (sem seguir links simbolicos), com caminhos relativos em '/'.
 * @param {string} baseDir
 * @param {string} subDir
 * @param {number} depth
 * @returns {Promise<string[]>}
 */
async function walk(baseDir, subDir, depth = 0) {
	if (depth >= MAX_DEPTH) {
		return [];
	}
	let entries;
	try {
		entries = await fs.promises.readdir(path.join(baseDir, subDir), { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const rel = subDir ? `${subDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...await walk(baseDir, rel, depth + 1));
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

/**
 * Coleta os arquivos de configuracao do Claude que podem ser sincronizados.
 * @param {string} claudeDir Pasta ~/.claude
 * @returns {Promise<{ files: Record<string, string>, paths: Record<string, string>, omitted: string[], skipped: string[] }>}
 */
async function collectClaudeFiles(claudeDir) {
	const files = {};
	const paths = {};
	const omitted = [];
	const skipped = [];

	const candidates = [];
	try {
		await fs.promises.access(path.join(claudeDir, 'CLAUDE.md'));
		candidates.push('CLAUDE.md');
	} catch {
		// sem CLAUDE.md global
	}
	for (const dir of CLAUDE_DIRS) {
		candidates.push(...await walk(claudeDir, dir));
	}

	let total = 0;
	for (const rel of candidates) {
		if (!isValidClaudeRelPath(rel)) {
			continue;
		}
		if (Object.keys(files).length >= MAX_FILES) {
			skipped.push(`claude:${rel}`);
			continue;
		}
		let content;
		try {
			const full = path.join(claudeDir, ...rel.split('/'));
			const stat = await fs.promises.stat(full);
			if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) {
				skipped.push(`claude:${rel}`);
				continue;
			}
			content = await fs.promises.readFile(full, 'utf8');
		} catch {
			continue;
		}
		if (looksSensitive(rel, content)) {
			omitted.push(`claude:${rel}`);
			continue;
		}
		const name = toGistName(rel);
		if (Object.prototype.hasOwnProperty.call(files, name)) {
			skipped.push(`claude:${rel}`);
			continue;
		}
		files[name] = content;
		paths[name] = rel;
		total += Buffer.byteLength(content, 'utf8');
	}
	return { files, paths, omitted, skipped };
}

/**
 * Descobre o caminho local de um arquivo vindo do Gist, somente se o manifesto o mapeia e o caminho e seguro.
 * @param {string} gistName
 * @param {Record<string, string> | undefined} manifestPaths
 * @returns {string | null}
 */
function restoreClaudePath(gistName, manifestPaths) {
	if (!manifestPaths || typeof manifestPaths !== 'object' || !Object.prototype.hasOwnProperty.call(manifestPaths, gistName)) {
		return null;
	}
	const rel = manifestPaths[gistName];
	return isValidClaudeRelPath(rel) ? rel : null;
}

/**
 * Resolve o destino de gravacao garantindo que fique dentro de ~/.claude.
 * @param {string} claudeDir
 * @param {string} rel
 * @returns {string | null}
 */
function resolveClaudePath(claudeDir, rel) {
	if (!isValidClaudeRelPath(rel)) {
		return null;
	}
	const base = path.resolve(claudeDir);
	const target = path.resolve(base, ...rel.split('/'));
	const relative = path.relative(base, target);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		return null;
	}
	return target;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isClaudeGistName(name) {
	return typeof name === 'string' && name.startsWith(CLAUDE_PREFIX);
}

module.exports = {
	CLAUDE_PREFIX,
	isValidClaudeRelPath,
	toGistName,
	collectClaudeFiles,
	restoreClaudePath,
	resolveClaudePath,
	isClaudeGistName
};
