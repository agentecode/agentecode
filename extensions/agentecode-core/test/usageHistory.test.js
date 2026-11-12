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

	test('o detalhe do dia separa por tipo de uso, conversa, hora e respostas mais caras', async () => {
		const entries = await history.loadHistory({ claudeDir });
		const now = new Date(2026, 9, 21, 18, 0, 0).getTime();
		const s = history.summarize(entries, { now, days: 7, detailDay: '2026-10-21' });
		assert.equal(s.detail.date, '2026-10-21');
		assert.equal(s.detail.usd, 13);
		assert.equal(s.detail.parts.input + s.detail.parts.output, 13, 'sonnet-5: entrada 2 por milhao, saida 10 por milhao');
		assert.equal(s.detail.hours[12], 13, 'as respostas foram ao meio-dia');
		assert.equal(s.detail.sessions.length, 1);
		assert.equal(s.detail.sessions[0].usd, 13);
		assert.equal(s.detail.sessions[0].subUsd, 12, 'o subagente fica separado dentro da conversa');
		assert.equal(s.detail.top[0].usd, 12);
		assert.equal(history.summarize(entries, { now, days: 7 }).detail.date, '2026-10-21', 'sem dia escolhido vale hoje');
		assert.equal(history.summarize(entries, { now, days: 7, detailDay: 'lixo' }).detail.date, '2026-10-21');
	});

	test('a tela mostra o detalhe do dia e as barras levam ao detalhe', async () => {
		const entries = await history.loadHistory({ claudeDir });
		const summary = history.summarize(entries, { now: new Date(2026, 9, 21, 18, 0, 0).getTime(), days: 30, detailDay: '2026-10-20' });
		const html = renderHistoryHtml(summary, { today: '2026-10-21', nonce: 'abc', cspSource: 'vscode-resource:' });
		assert.ok(html.includes('Details of 20/10'));
		assert.ok(html.includes('Where the cost comes from'));
		assert.ok(html.includes('data-day="2026-10-20"'));
		assert.match(html, /type:.day./);
	});

	test('conversa apagada continua valendo: o resumo guardado fica marcado como apagado', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-gone-'));
		try {
			const proj = path.join(dir, 'projects', 'C--p');
			fs.mkdirSync(proj, { recursive: true });
			const file = path.join(proj, 'sessX.jsonl');
			fs.writeFileSync(file, assistant('g1', noon(2026, 10, 21), { input_tokens: 1_000_000, output_tokens: 0 }) + '\n');
			const cache = path.join(dir, 'cache.json');
			const before = await history.loadHistory({ claudeDir: dir, cacheFile: cache });
			assert.equal(before.length, 1);
			assert.equal(before[0].gone, false);
			fs.rmSync(file);
			const after = await history.loadHistory({ claudeDir: dir, cacheFile: cache });
			assert.equal(after.length, 1, 'o arquivo sumiu mas o resumo ficou');
			assert.equal(after[0].gone, true);
			assert.equal(after[0].data.days['2026-10-21'].usd, 2);
			const s = history.summarize(after, { now: new Date(2026, 9, 21, 18).getTime(), days: 7 });
			assert.equal(s.totals.today, 2);
			assert.deepEqual(s.gone, { sessions: 1, usd: 2 });
			assert.equal(s.detail.sessions[0].gone, true);
			// depois de muito tempo apagada, sai do arquivo de totais
			const much = await history.loadHistory({ claudeDir: dir, cacheFile: cache, now: Date.now() + 800 * 24 * 3600 * 1000 });
			assert.equal(much.length, 0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('o resumo compara o periodo com o anterior e junta os limites guardados', async () => {
		const entries = await history.loadHistory({ claudeDir });
		const now = new Date(2026, 9, 21, 18, 0, 0).getTime();
		const s = history.summarize(entries, {
			now,
			days: 2,
			limitSamples: [
				{ t: new Date(2026, 9, 21, 9).getTime(), s: 5, sr: 1, w: 40, wr: 9 },
				{ t: new Date(2026, 9, 21, 17).getTime(), s: 20, sr: 1, w: 46, wr: 9 }
			]
		});
		assert.equal(s.compare.current.from, '2026-10-20');
		assert.equal(s.compare.current.usd, 25);
		assert.equal(s.compare.current.replies, 3, 'a do dia 20, a do dia 21 e a do subagente; a repetida conta uma vez');
		assert.equal(s.compare.previous.usd, 0);
		assert.equal(s.compare.partial, true, 'os dados comecam depois do inicio do periodo anterior');
		assert.equal(s.limits.days.length, 1);
		assert.equal(s.limits.days[0].weeklyDelta, 6);
		assert.equal(s.limits.days[0].fiveMax, 20);
		assert.equal(s.limits.days[0].perPoint, 13 / 6);
		const html = renderHistoryHtml(s, { today: '2026-10-21', nonce: 'abc', cspSource: 'vscode-resource:' });
		assert.ok(html.includes('Compared with the previous 2 days'));
		assert.ok(html.includes('Subscription limits over time'));
		assert.ok(html.includes('US$ per point'));
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
