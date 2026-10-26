/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const { filterSettings, filterKeybindings, filterSnippets } = require('./exclusions');
const { collectClaudeFiles } = require('./claudeConfig');

/**
 * Calcula o hash SHA-256 de uma string em formato hexadecimal.
 * @param {string | Buffer} content
 * @returns {string}
 */
function sha256(content) {
	return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
}

/**
 * Calcula um hash composto e deterministico para o conjunto de arquivos.
 * @param {Record<string, string>} files Mapa de nome de arquivo -> conteudo
 * @returns {string}
 */
function computeCompositeHash(files) {
	const sortedNames = Object.keys(files || {}).sort();
	const hash = crypto.createHash('sha256');
	for (const name of sortedNames) {
		const content = files[name];
		const fileHash = sha256(content);
		hash.update(`${name}:${fileHash}\n`, 'utf8');
	}
	return hash.digest('hex');
}

/**
 * Saneia o nome de um arquivo de snippet para inclusao no Gist (Gists nao suportam pastas).
 * Substitui caracteres nao permitidos por '_' preservando a extensao.
 * @param {string} fileName Nome original do arquivo (ex.: 'csharp.json' ou 'meu snippet!.code-snippets')
 * @returns {{ gistFileName: string, originalName: string, sanitized: boolean }}
 */
function sanitizeSnippetName(fileName) {
	const clean = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
	const gistFileName = `${config.SNIPPET_PREFIX}${clean}`;
	return {
		gistFileName,
		originalName: fileName,
		sanitized: clean !== fileName
	};
}

/**
 * Valida rigorosamente se um nome de arquivo de snippet e seguro (prevencao de path traversal).
 * @param {string} name
 * @returns {boolean}
 */
function isValidSnippetFileName(name) {
	if (typeof name !== 'string' || !name.trim()) {
		return false;
	}
	if (name === '.' || name === '..' || /^\.+$/.test(name)) {
		return false;
	}
	if (name.includes('/') || name.includes('\\')) {
		return false;
	}
	if (!/^[A-Za-z0-9._-]+$/.test(name)) {
		return false;
	}
	if (!name.endsWith('.json') && !name.endsWith('.code-snippets')) {
		return false;
	}
	return true;
}

/**
 * Extrai o nome local original de um arquivo de snippet vindo do Gist com validacao anti-traversal.
 * @param {string} gistFileName Nome no Gist (ex.: 'snippets--csharp.json')
 * @param {Record<string, string>} [manifestSnippetNames] Mapeamento gravado no manifesto
 * @returns {string | null} Nome original validado ou null se for invalido/inseguro
 */
function restoreSnippetName(gistFileName, manifestSnippetNames = {}) {
	let candidate = gistFileName;
	if (manifestSnippetNames && typeof manifestSnippetNames === 'object' && Object.prototype.hasOwnProperty.call(manifestSnippetNames, gistFileName)) {
		candidate = manifestSnippetNames[gistFileName];
	} else if (gistFileName && gistFileName.startsWith(config.SNIPPET_PREFIX)) {
		candidate = gistFileName.slice(config.SNIPPET_PREFIX.length);
	}

	if (!isValidSnippetFileName(candidate)) {
		return null;
	}
	return candidate;
}

/**
 * Resolve com seguranca o caminho de gravacao de um snippet, garantindo que nao escape da pasta snippets/.
 * @param {string} snippetsDir
 * @param {string} snippetFileName
 * @returns {string | null}
 */
function resolveSnippetPath(snippetsDir, snippetFileName) {
	if (!isValidSnippetFileName(snippetFileName)) {
		return null;
	}
	const resolvedDir = path.resolve(snippetsDir);
	const targetPath = path.resolve(resolvedDir, snippetFileName);
	const relative = path.relative(resolvedDir, targetPath);
	if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
		return null;
	}
	return targetPath;
}

/**
 * Normaliza e ordena a lista de identificadores de extensoes do usuario.
 * @param {string[]} extensions
 * @returns {string[]}
 */
function normalizeExtensions(extensions) {
	if (!Array.isArray(extensions)) {
		return [];
	}
	const unique = new Set(
		extensions
			.map(id => (typeof id === 'string' ? id.trim().toLowerCase() : ''))
			.filter(Boolean)
	);
	return Array.from(unique).sort();
}

/**
 * Monta o snapshot local lendo os arquivos do disco atraves de um leitor injetavel.
 * @param {object} options
 * @param {string} options.userDir Diretorio 'User' do VS Code
 * @param {(filePath: string) => Promise<string | null>} options.readFile
 * @param {(dirPath: string) => Promise<string[]>} [options.readDir]
 * @param {() => Promise<string[]>} [options.listUserExtensions]
 * @param {string[]} [options.customExclusions]
 * @param {string | null} [options.claudeDir] Pasta ~/.claude; quando informada, inclui CLAUDE.md, commands, agents e skills
 * @returns {Promise<{ files: Record<string, string>, fileHashes: Record<string, string>, extensions: string[], compositeHash: string, snippetNames: Record<string, string> }>}
 */
async function createLocalSnapshot({
	userDir,
	readFile,
	readDir,
	listUserExtensions,
	customExclusions = [],
	claudeDir = null
}) {
	const files = {};
	const fileHashes = {};
	const snippetNames = {};
	const allOmitted = [];

	// 1. settings.json
	const settingsPath = path.join(userDir, config.SETTINGS_FILE);
	const rawSettings = await readFile(settingsPath);
	if (rawSettings !== null && rawSettings !== undefined) {
		const { text: filtered, omitted } = filterSettings(rawSettings, customExclusions);
		files[config.SETTINGS_FILE] = filtered;
		fileHashes[config.SETTINGS_FILE] = sha256(filtered);
		if (Array.isArray(omitted)) {
			allOmitted.push(...omitted);
		}
	}

	// 2. keybindings.json
	const keybindingsPath = path.join(userDir, config.KEYBINDINGS_FILE);
	const rawKeybindings = await readFile(keybindingsPath);
	if (rawKeybindings !== null && rawKeybindings !== undefined) {
		const { text: filtered, omitted } = filterKeybindings(rawKeybindings);
		files[config.KEYBINDINGS_FILE] = filtered;
		fileHashes[config.KEYBINDINGS_FILE] = sha256(filtered);
		if (Array.isArray(omitted)) {
			allOmitted.push(...omitted);
		}
	}

	// 3. snippets/
	if (readDir) {
		const snippetsDir = path.join(userDir, 'snippets');
		try {
			const entries = await readDir(snippetsDir);
			for (const entry of entries) {
				if (isValidSnippetFileName(entry)) {
					const snippetPath = path.join(snippetsDir, entry);
					const snippetContent = await readFile(snippetPath);
					if (snippetContent !== null && snippetContent !== undefined) {
						const { text: filteredSnippet, omitted: snippetOmitted } = filterSnippets(snippetContent);
						const { gistFileName, originalName, sanitized } = sanitizeSnippetName(entry);
						files[gistFileName] = filteredSnippet;
						fileHashes[gistFileName] = sha256(filteredSnippet);
						if (sanitized) {
							snippetNames[gistFileName] = originalName;
						}
						if (Array.isArray(snippetOmitted)) {
							allOmitted.push(...snippetOmitted);
						}
					}
				}
			}
		} catch {
			// pasta de snippets pode nao existir, segue normal
		}
	}

	// 3b. Configuracao do Claude (opcional)
	let claudePaths = {};
	if (claudeDir) {
		const claude = await collectClaudeFiles(claudeDir);
		for (const [gistName, content] of Object.entries(claude.files)) {
			files[gistName] = content;
			fileHashes[gistName] = sha256(content);
		}
		claudePaths = claude.paths;
		allOmitted.push(...claude.omitted);
	}

	// 4. extensions.json
	let userExtensions = [];
	if (listUserExtensions) {
		try {
			const list = await listUserExtensions();
			userExtensions = normalizeExtensions(list);
		} catch {
			userExtensions = [];
		}
	}
	const extensionsJson = JSON.stringify({ extensions: userExtensions }, null, '\t') + '\n';
	files[config.EXTENSIONS_FILE] = extensionsJson;
	fileHashes[config.EXTENSIONS_FILE] = sha256(extensionsJson);

	// 5. LEIA-ME.md
	files[config.README_FILE] = config.README_CONTENT;
	fileHashes[config.README_FILE] = sha256(config.README_CONTENT);

	// 6. Hash composto
	const compositeHash = computeCompositeHash(files);

	return {
		files,
		fileHashes,
		extensions: userExtensions,
		compositeHash,
		snippetNames,
		claudePaths,
		omitted: allOmitted
	};
}

/**
 * Cria o objeto de manifesto 'agentecode-sync.json'.
 * @param {object} snapshot Retorno de createLocalSnapshot
 * @param {object} machineInfo
 * @param {string} [machineInfo.appVersion]
 * @param {string} [machineInfo.id]
 * @param {string} [machineInfo.name]
 * @param {string} [machineInfo.platform]
 * @returns {string} Conteudo JSON formatado do manifesto
 */
function buildManifest(snapshot, machineInfo = {}) {
	const filesMeta = {};
	for (const [name, content] of Object.entries(snapshot.files)) {
		if (name === config.MANIFEST_FILE) {
			continue;
		}
		filesMeta[name] = {
			sha256: snapshot.fileHashes[name] || sha256(content),
			size: Buffer.byteLength(content, 'utf8')
		};
	}

	const manifest = {
		schema: 1,
		app: 'AgenteCode',
		appVersion: machineInfo.appVersion || '1.0.4',
		savedAt: new Date().toISOString(),
		machine: {
			id: machineInfo.id || 'unknown',
			name: machineInfo.name || 'DESKTOP',
			platform: machineInfo.platform || process.platform
		},
		compositeHash: snapshot.compositeHash,
		files: filesMeta
	};

	if (snapshot.snippetNames && Object.keys(snapshot.snippetNames).length > 0) {
		manifest.snippetNames = snapshot.snippetNames;
	}

	if (snapshot.claudePaths && Object.keys(snapshot.claudePaths).length > 0) {
		manifest.claudePaths = snapshot.claudePaths;
	}

	return JSON.stringify(manifest, null, '\t') + '\n';
}

/**
 * Deserializa arquivos remotos recebidos do Gist em um mapa legivel.
 * @param {Record<string, { content?: string, raw_url?: string }>} gistFiles
 * @returns {{ files: Record<string, string>, manifest: any, extensions: string[] }}
 */
function parseRemoteGistFiles(gistFiles = {}) {
	const files = {};
	let manifest = null;
	let extensions = [];

	for (const [name, fileObj] of Object.entries(gistFiles)) {
		if (!fileObj || typeof fileObj.content !== 'string') {
			continue;
		}
		files[name] = fileObj.content;
		if (name === config.MANIFEST_FILE) {
			try {
				manifest = JSON.parse(fileObj.content);
			} catch {
				manifest = null;
			}
		}
		if (name === config.EXTENSIONS_FILE) {
			try {
				const parsed = JSON.parse(fileObj.content);
				extensions = normalizeExtensions(parsed.extensions);
			} catch {
				extensions = [];
			}
		}
	}

	return { files, manifest, extensions };
}

module.exports = {
	sha256,
	computeCompositeHash,
	sanitizeSnippetName,
	isValidSnippetFileName,
	restoreSnippetName,
	resolveSnippetPath,
	normalizeExtensions,
	createLocalSnapshot,
	buildManifest,
	parseRemoteGistFiles
};
