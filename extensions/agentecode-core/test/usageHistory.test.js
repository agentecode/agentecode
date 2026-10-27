/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Module = require('module');

// A tela importa 'vscode'; o teste so usa a funcao pura que monta o HTML.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? {} : originalLoad.call(this, request, ...rest);
};
const history = require('../lib/usageHistory');
const { renderHistoryHtml } = require('../lib/usageHistoryView');
Module._load = originalLoad;

const noon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).toISOString();
const assistant = (id, ts, usage, model = 'claude-sonnet-5-5', extra = {}) =>
	JSON.stringify({ type: 'assistant', uuid: `u-${id}`, timestamp: ts, cwd: 'C:\\WorkStation\\MeuProjeto', message: { id, model, usage }, ...extra });

describe('Historico de uso e custo', () => {
	let claudeDir;
	let cacheFile;

	before(() => {
		claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-hist-'));
		cacheFile = path.join(claudeDir, 'cache.json');
		const proj = path.join(claudeDir, 'projects', 'C--WorkStation-MeuProjeto');
		fs.mkdirSync(path.join(proj, 'sess1', 'subagents'), { recursive: true });
		const oneMillion = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
		fs.writeFileSync(path.join(proj, 'sess1.jsonl'), [
			assistant('m1', noon(2026, 10, 20), oneMillion), // US$ 12 (sonnet-5: 2 + 10)
			assistant('m1', noon(2026, 10, 20), oneMillion), // repetida: conta uma vez
			assistant('m2', noon(2026, 10, 21), { input_tokens: 500_000, output_tokens: 0 }), // US$ 1
			assistant('m3', noon(2026, 10, 21), { input_tokens: 10, output_tokens: 10 }, '<synthetic>'), // ignorada
			'linha invalida',
			JSON.stringify({ type: 'user', timestamp: noon(2026, 10, 21), message: { content: 'oi' } })
		].join('\n') + '\n');
		fs.writeFileSync(path.join(proj, 'sess1', 'subagents', 'agent-a.jsonl'),
			assistant('s1', noon(2026, 10, 21), oneMillion, 'claude-sonnet-5-5', { isSidechain: true }) + '\n'); // US$ 12 do subagente
	});

	after(() => {
		fs.rmSync(claudeDir, { recursive: true, force: true });
	});

	test('scanFile soma por dia, ignora repetidas e respostas sinteticas', async () => {
		const data = await history.scanFile(path.join(claudeDir, 'projects', 'C--WorkStation-MeuProjeto', 'sess1.jsonl'));
		assert.equal(data.cwd, 'C:\\WorkStation\\MeuProjeto');
		assert.equal(data.days['2026-10-20'].usd, 12);
		assert.equal(data.days['2026-10-21'].usd, 1);
		assert.equal(data.days['2026-10-21'].input, 500_000);
	});

	test('loadHistory inclui subagentes e reaproveita o cache', async () => {
		const first = await history.loadHistory({ claudeDir, cacheFile });
		assert.equal(first.length, 2);
		assert.equal(first.filter(e => e.isSub).length, 1);
		assert.ok(fs.existsSync(cacheFile));

		// adultera o cache: se ele for reaproveitado, o valor adulterado aparece
		const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
		const key = Object.keys(cache.files).find(k => k.endsWith('sess1.jsonl'));
		cache.files[key].data.days['2026-10-20'].usd = 999;
		fs.writeFileSync(cacheFile, JSON.stringify(cache));
		const second = await history.loadHistory({ claudeDir, cacheFile });
		assert.equal(second.find(e => !e.isSub).data.days['2026-10-20'].usd, 999);
	});

	test('summarize agrupa por dia, projeto e modelo e calcula os totais', async () => {
		const entries = await history.loadHistory({ claudeDir });
		const now = new Date(2026, 9, 21, 18, 0, 0).getTime();
		const s = history.summarize(entries, { now, days: 7 });
		assert.equal(s.byDay.length, 7);
		assert.equal(s.byDay[s.byDay.length - 1].date, '2026-10-21');
		assert.equal(s.byDay[s.byDay.length - 1].usd, 13); // 1 + 12 do subagente
		assert.equal(s.byDay.find(d => d.date === '2026-10-20').usd, 12);
		assert.equal(s.totals.today, 13);
		assert.equal(s.totals.week, 25);
		assert.equal(s.totals.range, 25);
		assert.equal(s.totals.sessions, 1);
		assert.deepEqual(s.byProject.map(p => [p.name, p.usd, p.sessions]), [['MeuProjeto', 25, 1]]);
		assert.deepEqual(s.byModel, [{ model: 'claude-sonnet-5-5', usd: 25 }]);

		const short = history.summarize(entries, { now, days: 1 });
		assert.equal(short.totals.range, 13);
		assert.equal(short.totals.week, 25, 'totais fixos nao dependem do periodo escolhido');
	});

	test('projectName usa a ultima pasta do cwd ou o nome codificado', () => {
		assert.equal(history.projectName('x', 'C:\\a\\b\\Projeto\\'), 'Projeto');
		assert.equal(history.projectName('/home/u/app', '/home/u/app'), 'app');
		assert.equal(history.projectName('-home-u-app', null), 'home-u-app');
	});

	test('a tela renderiza totais, grafico e escapa nomes', async () => {
		const entries = await history.loadHistory({ claudeDir });
		entries[0].data.cwd = 'C:\\x\\<script>alert(1)</script>';
		const now = new Date(2026, 9, 21, 18, 0, 0).getTime();
		const html = renderHistoryHtml(history.summarize(entries, { now, days: 30 }), { today: '2026-10-21', nonce: 'abc', cspSource: 'vscode-resource:' });
		assert.ok(html.includes('US$ 25.00'));
		assert.ok(html.includes('<svg'));
		assert.ok(!html.includes('<script>alert(1)'));
		assert.ok(html.includes('nonce-abc'));
	});

	test('a tela sai em ingles por padrao e em portugues com o idioma pt', async () => {
		const i18n = require('../lib/i18n');
		const entries = await history.loadHistory({ claudeDir });
		const summary = history.summarize(entries, { now: new Date(2026, 9, 21, 18, 0, 0).getTime(), days: 30 });
		const options = { today: '2026-10-21', nonce: 'abc', cspSource: 'vscode-resource:' };
		assert.ok(renderHistoryHtml(summary, options).includes('Usage and cost history'));
		i18n.setLanguage('pt');
		try {
			assert.ok(renderHistoryHtml(summary, options).includes('Histórico de uso e custo'));
		} finally {
			i18n.setLanguage('en');
		}
	});
});
