/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Mudancas feitas "por fora" do registro do Claude Code (perl, sed, scripts, cat >, outras ferramentas):
// comparadas com a foto do projeto tirada no comeco do pedido ou, sem foto, de forma aproximada com o ultimo commit
// anterior a conversa.
// Sem VS Code.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const gs = require('./gitSnapshot');

const MAX_ITEMS = 500;
/** Folga ao redor do horario da conversa no modo aproximado (o disco pode ser mexido logo depois da ultima mensagem). */
const WINDOW_SLACK_MS = 15 * 60 * 1000;

const STATUS = { A: 'added', M: 'modified', D: 'deleted' };

/**
 * Guarda o conteudo de antes de um arquivo numa pasta de cache (para o diff e para o Desfazer) e devolve o caminho.
 * @param {string} beforeDir
 * @param {string} root
 * @param {string} tree
 * @param {string} relPath
 * @returns {Promise<string | undefined>}
 */
async function materializeBefore(beforeDir, root, tree, relPath) {
	const content = await gs.blobAt(root, tree, relPath);
	if (content === null) {
		return undefined;
	}
	const name = crypto.createHash('sha1').update(`${tree}:${relPath}`).digest('hex');
	const target = path.join(beforeDir, name);
	await fs.promises.mkdir(beforeDir, { recursive: true });
	try {
		await fs.promises.access(target);
	} catch {
		await fs.promises.writeFile(target, content);
	}
	return target;
}

/**
 * Arquivos alterados no projeto desde a foto `baseTree` (modo exato) ou desde o ultimo commit dentro da janela de
 * horario da conversa (modo aproximado, quando nao ha foto).
 *
 * @param {{ repoRoot: string, baseTree?: string, nowTree?: string, beforeDir: string, window?: { from: number, to: number } }} options
 * @returns {Promise<{ mode: 'exact' | 'approx' | 'none', truncated: boolean, items: { file: string, status: 'added' | 'modified' | 'deleted', backup?: string, added: number | null, removed: number | null, source: 'terminal', approx: boolean }[] }>}
 */
async function computeTerminalChanges({ repoRoot, baseTree, nowTree, beforeDir, window }) {
	let mode = 'none';
	let tree;
	let changes = [];

	if (baseTree && await gs.hasObject(repoRoot, baseTree)) {
		mode = 'exact';
		tree = baseTree;
		changes = await gs.diffTrees(repoRoot, baseTree, nowTree ?? await gs.snapshotTree(repoRoot));
	} else {
		// sem foto: compara com o ultimo commit ANTERIOR a conversa, para nao perder o que foi commitado no meio dela
		const baseCommit = window ? await gs.commitBefore(repoRoot, new Date(window.from)) : null;
		const head = baseCommit ?? await gs.headTree(repoRoot);
		if (head) {
			mode = 'approx';
			tree = head;
			changes = baseCommit ? await gs.changesSince(repoRoot, baseCommit) : await gs.changesVsHead(repoRoot);
			if (window) {
				const kept = [];
				for (const change of changes) {
					if (change.status === 'D') {
						kept.push(change);
						continue;
					}
					try {
						const { mtimeMs } = await fs.promises.stat(path.join(repoRoot, ...change.path.split('/')));
						if (mtimeMs >= window.from - WINDOW_SLACK_MS && mtimeMs <= window.to + WINDOW_SLACK_MS) {
							kept.push(change);
						}
					} catch {
						// sumiu no meio
					}
				}
				changes = kept;
			}
		}
	}

	const truncated = changes.length > MAX_ITEMS;
	const items = [];
	for (const change of changes.slice(0, MAX_ITEMS)) {
		const status = STATUS[change.status];
		const backup = status === 'added' || !tree ? undefined : await materializeBefore(beforeDir, repoRoot, tree, change.path);
		if (status !== 'added' && !backup) {
			continue; // nao ha como mostrar o antes
		}
		items.push({
			file: path.join(repoRoot, ...change.path.split('/')),
			status,
			backup,
			added: change.added,
			removed: change.removed,
			source: 'terminal',
			approx: mode === 'approx'
		});
	}
	return { mode, truncated, items };
}

module.exports = { computeTerminalChanges };
