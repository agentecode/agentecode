/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// "Fotos" do projeto feitas com o proprio git, sem mexer no indice, nos arquivos ou nos commits do usuario.
// Uma foto e um objeto de arvore (tree) com tudo que o git enxerga: arquivos rastreados e novos (respeitando o .gitignore).
// Serve para comparar o projeto antes e depois de um pedido ao agente, venha a mudanca de onde vier (ferramenta de edicao,
// perl, sed, script, etc.). Sem VS Code.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BUFFER = 256 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

/**
 * Roda o git e devolve a saida como Buffer.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number }} [options]
 * @returns {Promise<Buffer>}
 */
function git(cwd, args, options = {}) {
	return new Promise((resolve, reject) => {
		execFile('git', args, {
			cwd,
			env: { ...process.env, ...options.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
			maxBuffer: MAX_BUFFER,
			timeout: options.timeout ?? TIMEOUT_MS,
			encoding: 'buffer',
			windowsHide: true
		}, (error, stdout, stderr) => {
			if (error) {
				error.stderr = stderr ? stderr.toString('utf8') : '';
				reject(error);
			} else {
				resolve(stdout);
			}
		});
	});
}

const text = buffer => buffer.toString('utf8').trim();

/**
 * Raiz do repositorio git que contem `dir`, ou `null`.
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function repoRoot(dir) {
	try {
		return path.normalize(text(await git(dir, ['rev-parse', '--show-toplevel'])));
	} catch {
		return null;
	}
}

/**
 * Tira uma foto do projeto: devolve o id de uma arvore com todos os arquivos (rastreados e novos, sem os ignorados).
 * Usa um indice temporario, entao o indice, os arquivos e o historico do usuario ficam intactos.
 * @param {string} root
 * @returns {Promise<string>}
 */
async function snapshotTree(root) {
	const tmp = path.join(os.tmpdir(), `agentecode-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	try {
		const indexPath = path.resolve(root, text(await git(root, ['rev-parse', '--git-path', 'index'])));
		try {
			await fs.promises.copyFile(indexPath, tmp);
		} catch {
			// sem indice ainda: o add -A monta do zero
		}
		const env = { GIT_INDEX_FILE: tmp };
		await git(root, ['add', '-A'], { env });
		return text(await git(root, ['write-tree'], { env }));
	} finally {
		await fs.promises.rm(tmp, { force: true }).catch(() => { });
		await fs.promises.rm(`${tmp}.lock`, { force: true }).catch(() => { });
	}
}

/**
 * Arvore do commit atual (HEAD), ou `null` em repositorio sem commits.
 * @param {string} root
 * @returns {Promise<string | null>}
 */
async function headTree(root) {
	try {
		return text(await git(root, ['rev-parse', 'HEAD^{tree}']));
	} catch {
		return null;
	}
}

/**
 * `true` se o objeto existe no repositorio (fotos antigas podem ter sido limpas pelo git).
 * @param {string} root
 * @param {string} object
 */
async function hasObject(root, object) {
	try {
		await git(root, ['cat-file', '-e', object]);
		return true;
	} catch {
		return false;
	}
}

/**
 * @typedef {{ path: string, status: 'A' | 'M' | 'D', added: number | null, removed: number | null }} TreeChange
 */

/**
 * Diferencas entre duas arvores, com contagem de linhas.
 * @param {string} root
 * @param {string} baseTree
 * @param {string} nowTree
 * @returns {Promise<TreeChange[]>}
 */
async function diffTrees(root, baseTree, nowTree) {
	const status = (await git(root, ['diff-tree', '-r', '--name-status', '--no-renames', '-z', baseTree, nowTree])).toString('utf8').split('\0').filter(Boolean);
	/** @type {Map<string, TreeChange>} */
	const changes = new Map();
	for (let i = 0; i + 1 < status.length; i += 2) {
		const code = status[i][0];
		if (code === 'A' || code === 'M' || code === 'D') {
			changes.set(status[i + 1], { path: status[i + 1], status: code, added: null, removed: null });
		}
	}
	if (changes.size) {
		const numstat = (await git(root, ['diff-tree', '-r', '--numstat', '--no-renames', '-z', baseTree, nowTree])).toString('utf8').split('\0').filter(Boolean);
		for (const entry of numstat) {
			const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
			const change = match && changes.get(match[3]);
			if (change && match[1] !== '-') {
				change.added = Number(match[1]);
				change.removed = Number(match[2]);
			}
		}
	}
	return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Diferencas entre o disco agora e o commit atual (sem escrever nada no repositorio), para conversas sem foto.
 * @param {string} root
 * @returns {Promise<TreeChange[]>}
 */
async function changesVsHead(root) {
	const out = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).toString('utf8').split('\0').filter(Boolean);
	/** @type {TreeChange[]} */
	const changes = [];
	for (let i = 0; i < out.length; i++) {
		const entry = out[i];
		const code = entry.slice(0, 2);
		const file = entry.slice(3);
		if (code[0] === 'R' || code[0] === 'C') {
			i++; // o nome antigo vem em seguida
		}
		const status = code === '??' || code.includes('A') ? 'A' : code.includes('D') ? 'D' : 'M';
		changes.push({ path: file, status, added: null, removed: null });
	}
	if (changes.length) {
		try {
			const numstat = (await git(root, ['diff', '--numstat', '--no-renames', '-z', 'HEAD'])).toString('utf8').split('\0').filter(Boolean);
			for (const entry of numstat) {
				const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
				const change = match && changes.find(c => c.path === match[3]);
				if (change && match[1] !== '-') {
					change.added = Number(match[1]);
					change.removed = Number(match[2]);
				}
			}
		} catch {
			// repositorio sem commits: sem contagem
		}
	}
	return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Ultimo commit anterior a uma data, ou `null`.
 * @param {string} root
 * @param {Date} date
 * @returns {Promise<string | null>}
 */
async function commitBefore(root, date) {
	try {
		return text(await git(root, ['rev-list', '-1', `--before=${date.toISOString()}`, 'HEAD'])) || null;
	} catch {
		return null;
	}
}

/**
 * Diferencas entre o disco agora e um commit (sem escrever nada no repositorio): inclui o que ja foi commitado depois dele,
 * o que esta so no disco e os arquivos novos ainda fora do git.
 * @param {string} root
 * @param {string} commit
 * @returns {Promise<TreeChange[]>}
 */
async function changesSince(root, commit) {
	/** @type {Map<string, TreeChange>} */
	const changes = new Map();
	const status = (await git(root, ['diff', '--name-status', '--no-renames', '-z', commit])).toString('utf8').split('\0').filter(Boolean);
	for (let i = 0; i + 1 < status.length; i += 2) {
		const code = status[i][0];
		if (code === 'A' || code === 'M' || code === 'D') {
			changes.set(status[i + 1], { path: status[i + 1], status: code, added: null, removed: null });
		}
	}
	if (changes.size) {
		const numstat = (await git(root, ['diff', '--numstat', '--no-renames', '-z', commit])).toString('utf8').split('\0').filter(Boolean);
		for (const entry of numstat) {
			const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
			const change = match && changes.get(match[3]);
			if (change && match[1] !== '-') {
				change.added = Number(match[1]);
				change.removed = Number(match[2]);
			}
		}
	}
	const untracked = (await git(root, ['ls-files', '-o', '--exclude-standard', '-z'])).toString('utf8').split('\0').filter(Boolean);
	for (const file of untracked) {
		if (!changes.has(file)) {
			changes.set(file, { path: file, status: 'A', added: null, removed: null });
		}
	}
	return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Conteudo de um arquivo numa arvore (ou commit), ou `null` se nao existir la.
 * @param {string} root
 * @param {string} tree
 * @param {string} relPath caminho com '/'
 * @returns {Promise<Buffer | null>}
 */
async function blobAt(root, tree, relPath) {
	try {
		return await git(root, ['cat-file', 'blob', `${tree}:${relPath}`]);
	} catch {
		return null;
	}
}

module.exports = { git, repoRoot, snapshotTree, headTree, hasObject, diffTrees, changesVsHead, commitBefore, changesSince, blobAt };
