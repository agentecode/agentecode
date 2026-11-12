/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Comentarios do usuario sobre os trechos que o agente alterou, e o texto que vai para o chat do Claude.
// Sem dependencia do editor, para poder ser testado.

/** Quantas linhas do trecho entram no texto enviado e quantos itens a lista de rejeitados guarda. */
const SNIPPET_LINES = 8;
const MAX_REJECTED = 50;

/**
 * @typedef {{ file: string, key: string, line: number, text: string, snippet: string[] }} ReviewComment
 * @typedef {{ file: string, line?: number, snippet?: string[] }} RejectedChange
 */

/**
 * Coloca (ou troca) o comentario de um trecho; texto vazio apaga.
 * @param {ReviewComment[]} list
 * @param {ReviewComment} comment
 * @returns {ReviewComment[]}
 */
function setComment(list, comment) {
	const others = list.filter(c => !(c.file === comment.file && c.key === comment.key));
	const text = String(comment.text ?? '').trim();
	return text ? [...others, { ...comment, text, snippet: (comment.snippet ?? []).slice(0, SNIPPET_LINES) }] : others;
}

/**
 * Anota uma mudanca recusada, sem repetir a mesma e guardando so as mais recentes.
 * @param {RejectedChange[]} list
 * @param {RejectedChange} change
 * @returns {RejectedChange[]}
 */
function addRejected(list, change) {
	const same = c => c.file === change.file && c.line === change.line;
	return [...list.filter(c => !same(c)), { ...change, snippet: (change.snippet ?? []).slice(0, 3) }].slice(-MAX_REJECTED);
}

/**
 * Texto que o usuario cola no chat do Claude: comentarios por trecho e o que ele descartou.
 * @param {ReviewComment[]} comments  arquivos ja em caminho relativo
 * @param {RejectedChange[]} rejected  idem
 * @returns {string}
 */
function buildPrompt(comments, rejected) {
	const lines = ['I reviewed your changes and have comments. Go through them one by one: fix the code where needed and reply briefly to each.', ''];
	comments.forEach((c, index) => {
		lines.push(`${index + 1}. ${c.file}:${c.line}`);
		if (c.snippet && c.snippet.length) {
			lines.push('   Code:', '   ```', ...c.snippet.map(s => `   ${s}`), '   ```');
		}
		lines.push(`   Comment: ${c.text.replace(/\r?\n/g, '\n   ')}`, '');
	});
	if (rejected.length) {
		lines.push('Changes I discarded. Do not apply them again:');
		for (const r of rejected) {
			if (r.line) {
				lines.push(`- ${r.file}:${r.line}${r.snippet && r.snippet.length ? ` (the lines starting with: ${r.snippet[0].trim()})` : ''}`);
			} else {
				lines.push(`- ${r.file} (the whole file was reverted)`);
			}
		}
	}
	return lines.join('\n').trimEnd() + '\n';
}

module.exports = { setComment, addRejected, buildPrompt, SNIPPET_LINES, MAX_REJECTED };
