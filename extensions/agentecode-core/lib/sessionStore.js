/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { claudeConfigDir, listSessionFiles, readSessionSummary } = require('./sessionMarkdown');
const { t } = require('./i18n');

/** Sessao alterada ha menos que isto e considerada em uso (o Claude Code ainda grava nela). */
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

/** @type {Map<string, { title: string, cwd?: string }>} */
const summaryCache = new Map();

/**
 * Lista as sessoes com titulo, usando cache por (arquivo, data, tamanho).
 * @param {string[]} workspaceFolders
 * @param {number} limit
 */
async function listSessions(workspaceFolders, limit = 200) {
	const files = await listSessionFiles(workspaceFolders, limit);
	return Promise.all(files.map(async f => {
		const key = `${f.file}|${f.mtime}|${f.size}`;
		let summary = summaryCache.get(key);
		if (!summary) {
			summary = await readSessionSummary(f.file).catch(() => ({ title: t('Unreadable session') }));
			summaryCache.set(key, summary);
		}
		return { ...f, title: summary.title, cwd: summary.cwd };
	}));
}

/** @param {number} mtime */
function isActiveSession(mtime) {
	return Date.now() - mtime < ACTIVE_WINDOW_MS;
}

/**
 * Texto das mensagens (usuario e Claude) de uma entrada, para a busca.
 * @param {any} entry
 */
function entryText(entry) {
	const content = entry?.message?.content;
	if (typeof content === 'string') {
		return content;
	}
	return Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
}

/**
 * `true` se alguma mensagem da sessao contem `query` (sem diferenciar maiusculas).
 * @param {string} file
 * @param {string} query
 * @param {{ isCancellationRequested: boolean }} [token]
 */
async function sessionMatches(file, query, token) {
	const needle = query.toLowerCase();
	const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (token?.isCancellationRequested) {
				return false;
			}
			// filtro barato antes do JSON.parse; acentos e emojis ficam crus no .jsonl
			if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) {
				continue;
			}
			if (!line.toLowerCase().includes(needle)) {
				continue;
			}
			try {
				if (entryText(JSON.parse(line)).toLowerCase().includes(needle)) {
					return true;
				}
			} catch {
				// linha truncada
			}
		}
	} finally {
		lines.close();
	}
	return false;
}

/**
 * Tudo o que pertence a uma sessao e deve ir junto para a Lixeira: o .jsonl, a pasta de mesmo nome ao lado
 * dele (dados auxiliares), as copias de arquivos em ~/.claude/file-history/<id> e os dados de ambiente da
 * sessao em ~/.claude/session-env/<id>. So devolve o que existe.
 * @param {string} file caminho do .jsonl
 * @returns {Promise<string[]>}
 */
async function sessionArtifacts(file) {
	const id = path.basename(file, '.jsonl');
	const candidates = [file, path.join(path.dirname(file), id), path.join(claudeConfigDir(), 'file-history', id), path.join(claudeConfigDir(), 'session-env', id)];
	const existing = [];
	for (const candidate of candidates) {
		try {
			await fs.promises.access(candidate);
			existing.push(candidate);
		} catch {
			// nao existe
		}
	}
	return existing;
}

/**
 * Pasta de copias de arquivos (checkpoints) de uma sessao.
 * @param {string} sessionId
 */
function fileHistoryDir(sessionId) {
	return path.join(claudeConfigDir(), 'file-history', sessionId);
}

module.exports = { listSessions, isActiveSession, sessionMatches, sessionArtifacts, fileHistoryDir, entryText, ACTIVE_WINDOW_MS };
