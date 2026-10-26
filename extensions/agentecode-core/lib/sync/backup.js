/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { resolveClaudePath, isValidClaudeRelPath } = require('./claudeConfig');

/**
 * Cria uma copia de seguranca local de settings.json, keybindings.json e snippets/ antes de aplicar mudancas.
 * Mantem no maximo 10 backups (config.MAX_BACKUPS_TO_KEEP), apagando os mais antigos.
 *
 * @param {string} userDir Diretorio 'User' do VS Code
 * @param {string} backupBaseDir Diretorio base onde os backups serao armazenados
 * @param {object} [options]
 * @param {number} [options.maxBackups]
 * @param {string} [options.claudeDir] Pasta ~/.claude, para guardar tambem os arquivos do Claude que existam
 * @param {string[]} [options.claudePaths] Caminhos relativos (em '/') dos arquivos do Claude a guardar
 * @returns {Promise<{ backupPath: string, filesCopied: string[], timestamp: string }>}
 */
async function createBackup(userDir, backupBaseDir, options = {}) {
	const maxBackups = options.maxBackups || config.MAX_BACKUPS_TO_KEEP;
	const now = new Date();
	// Substitui ':' por '-' para compatibilidade com sistema de arquivos Windows
	const dirName = now.toISOString().replace(/:/g, '-');
	const backupPath = path.join(backupBaseDir, dirName);

	await fs.promises.mkdir(backupPath, { recursive: true });

	const filesCopied = [];

	// 1. settings.json
	const settingsSrc = path.join(userDir, config.SETTINGS_FILE);
	try {
		await fs.promises.copyFile(settingsSrc, path.join(backupPath, config.SETTINGS_FILE));
		filesCopied.push(config.SETTINGS_FILE);
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e;
		}
	}

	// 2. keybindings.json
	const keybindingsSrc = path.join(userDir, config.KEYBINDINGS_FILE);
	try {
		await fs.promises.copyFile(keybindingsSrc, path.join(backupPath, config.KEYBINDINGS_FILE));
		filesCopied.push(config.KEYBINDINGS_FILE);
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e;
		}
	}

	// 3. snippets/
	const snippetsSrc = path.join(userDir, 'snippets');
	try {
		const snippetEntries = await fs.promises.readdir(snippetsSrc);
		const targetSnippets = path.join(backupPath, 'snippets');
		await fs.promises.mkdir(targetSnippets, { recursive: true });

		for (const entry of snippetEntries) {
			const sSrc = path.join(snippetsSrc, entry);
			const sDst = path.join(targetSnippets, entry);
			await fs.promises.copyFile(sSrc, sDst);
			filesCopied.push(`snippets/${entry}`);
		}
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e;
		}
	}

	// 4. Arquivos da configuracao do Claude
	if (options.claudeDir && Array.isArray(options.claudePaths)) {
		for (const rel of options.claudePaths) {
			const src = resolveClaudePath(options.claudeDir, rel);
			const dst = resolveClaudePath(path.join(backupPath, 'claude'), rel);
			if (!src || !dst) {
				continue;
			}
			try {
				await fs.promises.mkdir(path.dirname(dst), { recursive: true });
				await fs.promises.copyFile(src, dst);
				filesCopied.push(`claude/${rel}`);
			} catch (e) {
				if (e.code !== 'ENOENT') {
					throw e;
				}
			}
		}
	}

	// 5. Metadados do backup
	const meta = {
		createdAt: now.toISOString(),
		files: filesCopied
	};
	await fs.promises.writeFile(path.join(backupPath, 'backup-meta.json'), JSON.stringify(meta, null, '\t') + '\n', 'utf8');

	// 6. Limpeza de backups antigos (mantem os maxBackups mais recentes)
	await pruneOldBackups(backupBaseDir, maxBackups);

	return {
		backupPath,
		filesCopied,
		timestamp: now.toISOString()
	};
}

/**
 * Remove backups antigos excedentes, mantendo apenas os mais recentes.
 * @param {string} backupBaseDir
 * @param {number} maxToKeep
 */
async function pruneOldBackups(backupBaseDir, maxToKeep) {
	try {
		const entries = await fs.promises.readdir(backupBaseDir, { withFileTypes: true });
		const dirs = entries
			.filter(e => e.isDirectory())
			.map(e => e.name)
			.sort() // ordenacao alfabetica por ISO date corresponde a ordem cronologica
			.reverse(); // mais novos primeiro

		if (dirs.length > maxToKeep) {
			const toDelete = dirs.slice(maxToKeep);
			for (const dir of toDelete) {
				const fullPath = path.join(backupBaseDir, dir);
				await fs.promises.rm(fullPath, { recursive: true, force: true }).catch(() => {});
			}
		}
	} catch {
		// falhas silenciosas na limpeza
	}
}

/**
 * Lista todos os backups existentes em backupBaseDir, ordenados do mais recente para o mais antigo.
 * @param {string} backupBaseDir
 * @returns {Promise<Array<{ dirName: string, backupPath: string, createdAt: string, files: string[] }>>}
 */
async function listBackups(backupBaseDir) {
	try {
		const entries = await fs.promises.readdir(backupBaseDir, { withFileTypes: true });
		const dirs = entries
			.filter(e => e.isDirectory())
			.map(e => e.name)
			.sort()
			.reverse();

		const list = [];
		for (const dirName of dirs) {
			const backupPath = path.join(backupBaseDir, dirName);
			let meta = null;
			try {
				const metaText = await fs.promises.readFile(path.join(backupPath, 'backup-meta.json'), 'utf8');
				meta = JSON.parse(metaText);
			} catch {
				meta = { createdAt: dirName, files: [] };
			}
			list.push({
				dirName,
				backupPath,
				createdAt: meta.createdAt || dirName,
				files: meta.files || []
			});
		}
		return list;
	} catch {
		return [];
	}
}

/**
 * Restaura arquivos de um backup de volta para o diretorio User.
 * @param {string} backupPath Caminho da pasta de backup a ser restaurada
 * @param {string} userDir Diretorio 'User' de destino
 * @param {string} [claudeDir] Pasta ~/.claude de destino para os arquivos guardados em claude/
 * @returns {Promise<{ restoredFiles: string[] }>}
 */
async function restoreBackup(backupPath, userDir, claudeDir) {
	const restoredFiles = [];

	// 1. settings.json
	const settingsSrc = path.join(backupPath, config.SETTINGS_FILE);
	try {
		await fs.promises.copyFile(settingsSrc, path.join(userDir, config.SETTINGS_FILE));
		restoredFiles.push(config.SETTINGS_FILE);
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e;
		}
	}

	// 2. keybindings.json
	const keybindingsSrc = path.join(backupPath, config.KEYBINDINGS_FILE);
	try {
		await fs.promises.copyFile(keybindingsSrc, path.join(userDir, config.KEYBINDINGS_FILE));
		restoredFiles.push(config.KEYBINDINGS_FILE);
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e;
		}
	}

	// 3. snippets/
	const snippetsSrc = path.join(backupPath, 'snippets');
	try {
		const snippetEntries = await fs.promises.readdir(snippetsSrc);
		const targetSnippets = path.join(userDir, 'snippets');
		await fs.promises.mkdir(targetSnippets, { recursive: true });

		for (const entry of snippetEntries) {
			await fs.promises.copyFile(path.join(snippetsSrc, entry), path.join(targetSnippets, entry));
			restoredFiles.push(`snippets/${entry}`);
		}
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e;
		}
	}

	// 4. Configuracao do Claude
	if (claudeDir) {
		const claudeSrc = path.join(backupPath, 'claude');
		const walkFiles = async (sub) => {
			let entries;
			try {
				entries = await fs.promises.readdir(path.join(claudeSrc, sub), { withFileTypes: true });
			} catch {
				return [];
			}
			const out = [];
			for (const entry of entries) {
				const rel = sub ? `${sub}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					out.push(...await walkFiles(rel));
				} else if (entry.isFile()) {
					out.push(rel);
				}
			}
			return out;
		};
		for (const rel of await walkFiles('')) {
			if (!isValidClaudeRelPath(rel)) {
				continue;
			}
			const src = resolveClaudePath(claudeSrc, rel);
			const dst = resolveClaudePath(claudeDir, rel);
			if (src && dst) {
				await fs.promises.mkdir(path.dirname(dst), { recursive: true });
				await fs.promises.copyFile(src, dst);
				restoredFiles.push(`claude/${rel}`);
			}
		}
	}

	return { restoredFiles };
}

module.exports = {
	createBackup,
	pruneOldBackups,
	listBackups,
	restoreBackup
};
