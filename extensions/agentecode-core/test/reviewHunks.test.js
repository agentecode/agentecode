/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeHunks, revertHunkInText } = require('../lib/reviewHunks');

const shape = hunks => hunks.map(h => [h.modStart, h.modEnd, h.beforeLines, h.afterLines]);

describe('Trechos alterados (hunks)', () => {
	test('textos iguais nao tem trechos', () => {
		assert.deepEqual(computeHunks('a\nb\n', 'a\nb\n'), []);
	});

	test('uma linha trocada vira um trecho', () => {
		const hunks = computeHunks('a\nb\nc\n', 'a\nB\nc\n');
		assert.deepEqual(shape(hunks), [[1, 2, ['b'], ['B']]]);
	});

	test('linhas acrescentadas e removidas em regioes diferentes viram trechos separados', () => {
		const before = 'um\ndois\ntres\nquatro\ncinco\nseis\n';
		const after = 'um\ndois\nNOVA\ntres\nquatro\nseis\n';
		const hunks = computeHunks(before, after);
		assert.deepEqual(shape(hunks), [
			[2, 3, [], ['NOVA']],
			[5, 5, ['cinco'], []]
		]);
	});

	test('arquivo novo e um unico trecho com tudo', () => {
		const hunks = computeHunks('', 'a\nb\n');
		assert.deepEqual(shape(hunks), [[0, 2, [], ['a', 'b']]]);
	});

	test('desfazer um trecho devolve as linhas de antes e mantem os outros', () => {
		const before = 'um\ndois\ntres\nquatro\ncinco\nseis\n';
		const after = 'um\ndois\nNOVA\ntres\nquatro\nseis\n';
		const [first, second] = computeHunks(before, after);
		assert.equal(revertHunkInText(after, first), 'um\ndois\ntres\nquatro\nseis\n');
		assert.equal(revertHunkInText(after, second), 'um\ndois\nNOVA\ntres\nquatro\ncinco\nseis\n');
	});

	test('desfazer todos os trechos, do ultimo para o primeiro, volta ao texto original', () => {
		const before = 'a\nb\nc\nd\ne\nf\ng\n';
		const after = 'A\nb\nc\nX\nY\nf\n';
		let text = after;
		for (const hunk of computeHunks(before, after).reverse()) {
			text = revertHunkInText(text, hunk);
		}
		assert.equal(text, before);
	});

	test('mantem o fim de linha CRLF e a falta de quebra final', () => {
		const after = 'a\r\nB\r\nc';
		const [hunk] = computeHunks('a\r\nb\r\nc', after);
		assert.equal(revertHunkInText(after, hunk), 'a\r\nb\r\nc');
	});

	test('arquivos enormes e muito diferentes caem em um unico trecho', () => {
		const before = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
		const after = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
		const hunks = computeHunks(before, after);
		assert.equal(hunks.length, 1);
		assert.equal(hunks[0].beforeLines.length, 3000);
	});

	test('chaves iguais para trechos iguais e diferentes para trechos diferentes', () => {
		const [h1] = computeHunks('a\nb\n', 'a\nB\n');
		const [h2] = computeHunks('x\nb\ny\n', 'x\nB\ny\n');
		const [h3] = computeHunks('a\nb\n', 'a\nC\n');
		assert.equal(h1.key, h2.key);
		assert.notEqual(h1.key, h3.key);
	});
});
