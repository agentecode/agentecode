/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Trechos (hunks) alterados entre o estado de antes e o atual de um arquivo, para Manter/Desfazer por trecho.
// Logica pura (sem VS Code).

const crypto = require('crypto');

/** Acima deste produto de linhas a comparacao fina e abandonada e o miolo vira um unico trecho. */
const MAX_DP_CELLS = 6_000_000;

/**
 * Linhas de um texto; o fim de linha final nao conta como uma linha a mais.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
	return text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split(/\r?\n/);
}

/**
 * @typedef {{ origStart: number, origEnd: number, modStart: number, modEnd: number, beforeLines: string[], afterLines: string[], key: string }} Hunk
 */

/** @returns {Hunk} */
function makeHunk(a, b, origStart, origEnd, modStart, modEnd) {
	const beforeLines = a.slice(origStart, origEnd);
	const afterLines = b.slice(modStart, modEnd);
	const key = crypto.createHash('sha1').update(`${beforeLines.join('\n')}\u0000${afterLines.join('\n')}`).digest('hex').slice(0, 16);
	return { origStart, origEnd, modStart, modEnd, beforeLines, afterLines, key };
}

/**
 * Trechos que diferem entre `before` e `after`, com posicoes em linhas (0-based, fim exclusivo).
 * @param {string} before
 * @param {string} after
 * @returns {Hunk[]}
 */
function computeHunks(before, after) {
	const a = splitLines(before);
	const b = splitLines(after);

	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
		suffix++;
	}
	const n = a.length - prefix - suffix;
	const m = b.length - prefix - suffix;
	if (n === 0 && m === 0) {
		return [];
	}
	if (n === 0 || m === 0 || n * m > MAX_DP_CELLS) {
		return [makeHunk(a, b, prefix, prefix + n, prefix, prefix + m)];
	}

	// LCS por programacao dinamica no miolo: dp[i][j] = tamanho da maior subsequencia comum de a'[i:] e b'[j:]
	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] = a[prefix + i] === b[prefix + j]
				? dp[(i + 1) * width + j + 1] + 1
				: Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
		}
	}

	const hunks = [];
	let i = 0;
	let j = 0;
	let open = null;
	const close = () => {
		if (open) {
			hunks.push(makeHunk(a, b, prefix + open.i, prefix + i, prefix + open.j, prefix + j));
			open = null;
		}
	};
	while (i < n || j < m) {
		if (i < n && j < m && a[prefix + i] === b[prefix + j]) {
			close();
			i++;
			j++;
			continue;
		}
		if (!open) {
			open = { i, j };
		}
		if (j >= m || (i < n && dp[(i + 1) * width + j] >= dp[i * width + j + 1])) {
			i++;
		} else {
			j++;
		}
	}
	close();
	return hunks;
}

/**
 * Texto atual com um trecho desfeito (volta as linhas de antes no lugar das de agora).
 * @param {string} afterText
 * @param {Hunk} hunk
 * @returns {string}
 */
function revertHunkInText(afterText, hunk) {
	const eol = afterText.includes('\r\n') ? '\r\n' : '\n';
	const endsWithNewline = afterText.endsWith('\n') || afterText === '';
	const lines = splitLines(afterText);
	lines.splice(hunk.modStart, hunk.modEnd - hunk.modStart, ...hunk.beforeLines);
	return lines.join(eol) + (lines.length && endsWithNewline ? eol : '');
}

module.exports = { splitLines, computeHunks, revertHunkInText };
