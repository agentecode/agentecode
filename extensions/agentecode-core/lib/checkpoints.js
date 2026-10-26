/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * Checkpoints de arquivos do Claude Code.
 *
 * Cada mensagem do usuario ganha um "snapshot" (`file-history-snapshot`) que guarda, para cada arquivo
 * rastreado, uma copia (`backupFileName`, em ~/.claude/file-history/<sessao>/) do conteudo no INICIO do turno.
 * `backupFileName: null` significa que o arquivo nao existia. Arquivos tocados pela primeira vez durante um
 * turno entram naquele snapshot por meio de `file-history-delta`. Os snapshots sao cumulativos.
 *
 * Voltar ao checkpoint X = para cada arquivo, usar a entrada do snapshot X; para arquivos que so passaram a
 * ser rastreados depois de X, usar a entrada do primeiro snapshot posterior que os contem (o estado anterior
 * a primeira edicao).
 */

const path = require('path');

/** Nome de backup valido: hash hexadecimal + "@v" + versao. Impede caminhos fora da pasta de historico. */
const BACKUP_NAME = /^[0-9a-f]+@v\d+$/i;

/**
 * @typedef {{ backupFileName: string | null, version?: number }} Backup
 * @typedef {{ messageId: string, order: number, timestamp?: string, files: Record<string, Backup> }} Snapshot
 */

/**
 * Reconstroi os snapshots, na ordem em que aparecem na sessao.
 * @param {any[]} entries
 * @returns {Snapshot[]}
 */
function collectSnapshots(entries) {
	/** @type {Map<string, Snapshot>} */
	const byId = new Map();
	let order = 0;
	const ensure = (/** @type {string} */ id, /** @type {string | undefined} */ timestamp) => {
		let snapshot = byId.get(id);
		if (!snapshot) {
			snapshot = { messageId: id, order: order++, timestamp, files: {} };
			byId.set(id, snapshot);
		}
		return snapshot;
	};

	for (const entry of entries) {
		if (entry.type === 'file-history-snapshot' && entry.snapshot) {
			const id = entry.messageId ?? entry.snapshot.messageId;
			if (id) {
				const snapshot = ensure(id, entry.snapshot.timestamp);
				Object.assign(snapshot.files, entry.snapshot.trackedFileBackups ?? {});
			}
		} else if (entry.type === 'file-history-delta' && entry.snapshotMessageId && entry.trackingPath) {
			ensure(entry.snapshotMessageId, entry.timestamp).files[entry.trackingPath] = entry.backup ?? { backupFileName: null };
		}
	}
	return [...byId.values()].sort((a, b) => a.order - b.order);
}

/** @param {any} content */
function promptText(content) {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content) && !content.some(b => b?.type === 'tool_result')) {
		return content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
	}
	return '';
}

/**
 * Lista os checkpoints (um por prompt do usuario que tem snapshot), do mais novo para o mais antigo.
 * @param {any[]} entries
 * @returns {{ messageId: string, prompt: string, timestamp?: string }[]}
 */
function listCheckpoints(entries) {
	const snapshotIds = new Set(collectSnapshots(entries).map(s => s.messageId));
	const result = [];
	for (const entry of entries) {
		if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || !snapshotIds.has(entry.uuid)) {
			continue;
		}
		const text = promptText(entry.message?.content).trim();
		if (text) {
			result.push({ messageId: entry.uuid, prompt: text.replace(/\s+/g, ' ').slice(0, 120), timestamp: entry.timestamp });
		}
	}
	return result.reverse();
}

/**
 * Plano para voltar os arquivos ao estado de antes do turno `messageId`.
 * @param {any[]} entries
 * @param {string} messageId
 * @returns {{ file: string, backupFileName: string | null }[] | undefined} `undefined` se o checkpoint nao existe
 */
function planRewind(entries, messageId) {
	const snapshots = collectSnapshots(entries);
	const start = snapshots.findIndex(s => s.messageId === messageId);
	if (start < 0) {
		return undefined;
	}
	/** @type {Map<string, string | null>} */
	const plan = new Map();
	for (const snapshot of snapshots.slice(start)) {
		for (const [file, backup] of Object.entries(snapshot.files)) {
			if (!plan.has(file)) {
				const name = backup?.backupFileName ?? null;
				if (name !== null && !BACKUP_NAME.test(name)) {
					continue; // nome suspeito: ignora em vez de arriscar um caminho inesperado
				}
				plan.set(file, name);
			}
		}
	}
	return [...plan].map(([file, backupFileName]) => ({ file, backupFileName }));
}

/** Compara caminhos do Windows sem diferenciar maiusculas e barras. */
function normalizePath(p) {
	const normalized = path.normalize(p);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * `true` se `file` esta dentro de alguma das pastas `roots`.
 * @param {string} file
 * @param {string[]} roots
 */
function isInsideAny(file, roots) {
	const target = normalizePath(file);
	return roots.some(root => {
		const base = normalizePath(root).replace(/[\\/]+$/, '');
		return target === base || target.startsWith(base + path.sep);
	});
}

/**
 * O Claude Code grava arquivos da pasta da conversa com caminho relativo a ela; aqui eles viram absolutos.
 * @param {{ file: string, backupFileName: string | null }[]} plan
 * @param {string | undefined} cwd Pasta da conversa
 */
function absolutizePlan(plan, cwd) {
	return plan.map(item => (cwd && !path.isAbsolute(item.file) ? { ...item, file: path.resolve(cwd, item.file) } : item));
}

module.exports = { collectSnapshots, listCheckpoints, planRewind, absolutizePlan, isInsideAny, BACKUP_NAME };
