/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { sampleOf, appendSample, limitsByDay, createLimitsLog, MIN_GAP_MS } = require('../lib/usageLimitsLog');

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('sampleOf ignora leitura velha ou vazia e copia percentuais e reinicios', () => {
	assert.equal(sampleOf(null, 1), null);
	assert.equal(sampleOf({ session: null, weekly: null }, 1), null);
	assert.equal(sampleOf({ session: { percent: 10, resetsAt: 5 }, weekly: { percent: 40, resetsAt: 9 }, stale: true }, 1), null);
	assert.deepEqual(sampleOf({ session: { percent: 10, resetsAt: 5 }, weekly: { percent: 40, resetsAt: 9 } }, 7), { t: 7, s: 10, sr: 5, w: 40, wr: 9 });
});

test('appendSample guarda mudancas sempre e leituras iguais so depois do intervalo', () => {
	const list = [];
	assert.equal(appendSample(list, { t: 1000, s: 10, sr: 1, w: 40, wr: 2 }), true);
	assert.equal(appendSample(list, { t: 2000, s: 10, sr: 1, w: 40, wr: 2 }), false, 'igual e logo em seguida');
	assert.equal(appendSample(list, { t: 3000, s: 11, sr: 1, w: 40, wr: 2 }), true, 'mudou');
	assert.equal(appendSample(list, { t: 3000 + MIN_GAP_MS, s: 11, sr: 1, w: 40, wr: 2 }), true, 'igual mas passou tempo');
	assert.equal(list.length, 3);
});

test('limitsByDay soma a subida da janela de 7 dias so dentro da mesma janela', () => {
	const samples = [
		{ t: at(10, 9), s: 5, sr: 1, w: 40, wr: 100 },
		{ t: at(10, 12), s: 30, sr: 1, w: 44, wr: 100 },
		{ t: at(10, 18), s: 60, sr: 1, w: 50, wr: 100 },
		{ t: at(11, 9), s: 3, sr: 2, w: 51, wr: 100 },
		{ t: at(11, 10), s: 4, sr: 2, w: 2, wr: 200 } // janela nova: nao conta como subida
	];
	const days = limitsByDay(samples);
	const d10 = days.get('2026-11-10');
	assert.equal(d10.weeklyDelta, 10);
	assert.equal(d10.fiveMax, 60);
	assert.equal(d10.weeklyEnd, 50);
	const d11 = days.get('2026-11-11');
	assert.equal(d11.weeklyDelta, 1, 'so o 50 para 51; a troca de janela fica de fora');
});

test('o registro em disco guarda e le de volta', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-log-'));
	try {
		const file = path.join(dir, 'log.json');
		const log = createLimitsLog(file);
		const now = Date.now();
		log.record({ session: { percent: 7, resetsAt: now + 1000 }, weekly: { percent: 30, resetsAt: now + 5000 } }, now);
		log.flush(now);
		const again = createLimitsLog(file);
		assert.equal(again.samples().length, 1);
		assert.equal(again.samples()[0].w, 30);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
