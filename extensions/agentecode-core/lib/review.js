/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Revisao do que o agente mudou numa conversa: compara, para cada arquivo rastreado pelo checkpoint,
// a copia de ANTES da primeira edicao com o que esta no disco agora. Logica pura (sem VS Code).

const crypto = require('crypto');
const { readEntries } = require('./sessionMarkdown');
const { collectSnapshots, listCheckpoints, planRewind, absolutizePlan, isInsideAny } = require('./checkpoints');
const { readIfExists, diffPlanAgainstDisk } = require('./rewindPlan');

/** Acima disto (por arquivo) nao se contam linhas: o diff do editor continua funcionando. */
const MAX_COUNT_BYTES = 1024 * 1024;
const MAX_EDIT_DISTANCE = 20000;

/** Entradas de checkpoint (snapshots e deltas) de uma sessao. */
async function readHistoryEntries(file) {
	const entries = [];
	await readEntries(file, entry => entries.push(entry), line => line.includes('"type":"file-history-'));
	return entries;
}

/** Linhas de um texto; o fim de linha final nao conta como uma linha a mais. */
function toLines(text) {
	return text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split(/\r?\n/);
}

/**
 * Conta linhas acrescentadas e removidas entre dois textos (distancia de edicao de Myers, so linhas).
 * @param {string} before
 * @param {string} after
 * @returns {{ added: number, removed: number } | null} `null` se o arquivo mudou demais para contar
 */
function countLineChanges(before, after) {
	const a = toLines(before);
	const b = toLines(after);
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, MAX_EDIT_DISTANCE);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	for (let d = 0; d <= max; d++) {
		for (let k = -d; k <= d; k += 2) {
			let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				const common = (n + m - d) / 2;
				return { added: m - common, removed: n - common };
			}
		}
	}
	return null;
}

/**
 * @param {Buffer | undefined} buffer
 * @returns {string | null} `null` para arquivo binario ou grande demais
 */
function asCountableText(buffer) {
	if (buffer === undefined) {
		return '';
	}
	if (buffer.length > MAX_COUNT_BYTES || buffer.includes(0)) {
		return null;
	}
	return buffer.toString('utf8');
}

/**
 * Impressao digital do conteudo atual de um arquivo, para saber se ele mudou depois de marcado como revisado.
 * @param {string} file
 * @returns {Promise<string>}
 */
async function fingerprint(file) {
	const content = await readIfExists(file);
	return content === undefined ? 'deleted' : crypto.createHash('sha1').update(content).digest('hex');
}

/**
 * Arquivos que o agente mudou na conversa, comparando o estado de antes da primeira edicao com o disco.
 * @param {{ file: string, id: string, cwd?: string }} session
 * @param {string[]} roots Pastas do projeto; arquivos fora delas sao ignorados
 * @param {{ baseMessageId?: string }} [options] `baseMessageId`: compara com o estado de antes deste turno (padrao: inicio da conversa)
 * @returns {Promise<{ firstMessageId: string | undefined, items: { file: string, status: 'modified' | 'added' | 'deleted', backup?: string, added: number | null, removed: number | null }[], missingBackups: number, outside: number }>}
 */
async function computeReview(session, roots, options = {}) {
	const entries = await readHistoryEntries(session.file);
	const snapshots = collectSnapshots(entries);
	const first = (options.baseMessageId && snapshots.find(s => s.messageId === options.baseMessageId)) || snapshots[0];
	if (!first) {
		return { firstMessageId: undefined, items: [], missingBackups: 0, outside: 0 };
	}
	const plan = absolutizePlan(planRewind(entries, first.messageId) ?? [], session.cwd ?? roots[0]);
	const inside = plan.filter(p => isInsideAny(p.file, roots));
	const { changes, missingBackups } = await diffPlanAgainstDisk(inside, session.id);

	const items = [];
	for (const change of changes) {
		const status = change.action === 'delete' ? 'added' : change.action === 'recreate' ? 'deleted' : 'modified';
		const before = change.backup ? asCountableText(await readIfExists(change.backup)) : '';
		const after = asCountableText(await readIfExists(change.file));
		const counts = before !== null && after !== null ? countLineChanges(before, after) : null;
		items.push({
			file: change.file,
			status,
			backup: change.backup,
			added: counts ? counts.added : null,
			removed: counts ? counts.removed : null
		});
	}
	items.sort((x, y) => x.file.localeCompare(y.file));
	return { firstMessageId: first.messageId, items, missingBackups, outside: plan.length - inside.length };
}

/**
 * Mantem so as entradas ainda nao revisadas (ou que mudaram desde que foram marcadas).
 * @param {{ file: string }[]} items
 * @param {Record<string, string>} reviewed arquivo -> impressao digital no momento em que foi marcado
 * @param {(file: string) => Promise<string>} [fingerprintOf]
 * @returns {Promise<{ pending: any[], hidden: number }>}
 */
async function splitReviewed(items, reviewed, fingerprintOf = fingerprint) {
	const pending = [];
	let hidden = 0;
	for (const item of items) {
		const stored = reviewed[item.file];
		if (stored !== undefined && stored === await fingerprintOf(item.file)) {
			hidden++;
		} else {
			pending.push(item);
		}
	}
	return { pending, hidden };
}

/** Reduz um prompt do usuario ao texto, para nao guardar imagens em base64 na memoria. */
function slimUser(entry) {
	const content = entry.message?.content;
	let text = '';
	if (typeof content === 'string') {
		text = content;
	} else if (Array.isArray(content) && !content.some(b => b?.type === 'tool_result')) {
		text = content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
	}
	return { type: 'user', uuid: entry.uuid, isMeta: entry.isMeta, isSidechain: entry.isSidechain, timestamp: entry.timestamp, message: { content: text } };
}

/**
 * Turnos da conversa que podem servir de ponto de comparacao (os que tem arquivos rastreados), do mais novo ao mais antigo.
 * @param {string} sessionFile
 * @returns {Promise<{ messageId: string, prompt: string, timestamp?: string }[]>}
 */
async function listBases(sessionFile) {
	const entries = [];
	await readEntries(sessionFile, entry => entries.push(entry.type === 'user' ? slimUser(entry) : entry), line => line.includes('"type":"user"') || line.includes('"type":"file-history-'));
	return listCheckpoints(entries).filter(c => planRewind(entries, c.messageId)?.length);
}

module.exports = { listBases, readHistoryEntries, countLineChanges, fingerprint, computeReview, splitReviewed };
