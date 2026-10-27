/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Cópia de github.com/AlessandroLobo/claude-usage-statusbar (MIT, versão 0.10.0); a fonte do código fica lá.

'use strict';

// Teste de fumaça da lógica pura: node test.js [pasta-do-projeto]
const assert = require('assert');
const core = require('../lib/usage/core');
const i18n = require('../lib/i18n');

// os textos esperados abaixo sao os em portugues, vindos do dicionario
i18n.setLanguage('pt');
core.setTranslator(i18n.t, 'pt-BR');

assert.strictEqual(core.formatTokens(65_300), '65k');
assert.strictEqual(core.formatTokens(1_000_000), '1M');
assert.strictEqual(core.formatElapsed(8 * 60_000), '8m');
assert.strictEqual(core.formatElapsed(125 * 60_000), '2h05');
assert.strictEqual(core.formatTurn(10_000), '0:10');
assert.strictEqual(core.contextWindow('claude-sonnet-5-5', 0), 1_000_000);
assert.strictEqual(core.contextWindow('claude-haiku-4-5', 0), 200_000);
assert.strictEqual(core.contextWindow('claude-sonnet-5-5', 500_000), 500_000);

// 1M de input a US$ 2/M = US$ 2; 1M de output a US$ 10/M = US$ 10 (Sonnet 5.5)
const usd = core.messageCost('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 });
assert.ok(Math.abs(usd - 12) < 1e-9, `custo esperado 12, veio ${usd}`);
assert.strictEqual(core.messageCost('modelo-desconhecido', { input_tokens: 1 }), null);

const paths = process.argv.slice(2);
const session = core.findSession(paths);
if (!session) {
  console.log('Sem sessão para', paths.length ? paths : '(qualquer projeto)');
} else {
  const tracker = new core.Tracker();
  const now = Date.now();
  const snap = tracker.update(session.file, now);
  const view = core.render(snap, now, { contextWindow: 0, showCost: true, showTurn: true, showSessionTime: true });
  console.log(session.file);
  console.log(view.text);
}
// leitura incremental sobre um transcript sintético
const fs = require('fs');
const os = require('os');
const path = require('path');
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cub-')), 's.jsonl');
const rec = (type, ts, extra) => JSON.stringify({ type, timestamp: ts, ...extra }) + '\n';
fs.writeFileSync(
  file,
  rec('user', '2026-01-01T10:00:00Z', { message: { role: 'user', content: 'oi' } }) +
    rec('assistant', '2026-01-01T10:00:20Z', {
      message: { id: 'm1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 9000 } },
    }),
);
const t = new core.Tracker();
const a = t.update(file, Date.parse('2026-01-01T10:05:00Z'));
assert.strictEqual(a.ctxTokens, 10_100);
assert.strictEqual(a.turnMs, 20_000);
assert.strictEqual(a.running, false);
fs.appendFileSync(file, rec('assistant', '2026-01-01T10:06:00Z', {
  message: { id: 'm1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 9000 } },
}));
const b = t.update(file, Date.parse('2026-01-01T10:07:00Z'));
assert.ok(b.costUsd > a.costUsd, 'mesma mensagem reaparecendo deve substituir, não somar');
assert.ok(Math.abs(b.costUsd - (1000 * 2 + 200 * 10 + 9000 * 0.2) / 1e6) < 1e-12);
// limites 5h/7d a partir de um snapshot sintético da claude-usage-meter
assert.strictEqual(core.formatRemaining(4 * 3_600_000 + 18 * 60_000), '4h18');
assert.strictEqual(core.formatRemaining(26 * 3_600_000), '1d 2h');
assert.strictEqual(core.formatRemaining(12 * 60_000), '12m');

const snapFile = path.join(path.dirname(file), 'usage-snapshot.json');
const at = Date.parse('2026-01-01T10:07:00Z');
const writeSnap = (v, receivedAt) =>
  fs.writeFileSync(
    snapFile,
    JSON.stringify({
      v,
      report: {
        receivedAt,
        session: { utilization: 12.4, resetsAt: at + 4 * 3_600_000 + 18 * 60_000 },
        weekly: { utilization: 49, resetsAt: at + 2 * 3_600_000 + 28 * 60_000 },
      },
    }),
  );
const lim = { snapshotPath: snapFile, staleMinutes: 15 };
const allOpts = { contextWindow: 0, showCost: true, showTurn: true, showSessionTime: true, showLimits: true };

writeSnap(1, at - 60_000);
const fresh = core.readLimits(at, lim);
assert.strictEqual(fresh.session.percent, 12);
assert.strictEqual(fresh.stale, false);
const v = core.render(b, at, allOpts, fresh);
assert.ok(v.text.includes('5h 12% ↻4h18'), v.text);
assert.ok(v.text.includes('7d 49% ↻2h28'), v.text);
assert.ok(core.renderPanel(b, at, allOpts, fresh).includes('Sessão (5h)'));

writeSnap(1, at - 20 * 60_000);
const old = core.readLimits(at, lim);
assert.strictEqual(old.stale, true);
assert.ok(!core.render(b, at, allOpts, old).text.includes('5h '), 'leitura velha não deve aparecer');

writeSnap(2, at);
assert.strictEqual(core.readLimits(at, lim), null, 'versão desconhecida do snapshot é ignorada');
assert.strictEqual(core.readLimits(at, { snapshotPath: path.join(path.dirname(file), 'nao-existe.json'), staleMinutes: 15 }), null);
assert.ok(core.render(b, at, allOpts, null).text.includes('US$'), 'sem snapshot a barra segue funcionando');

// trechos separados (cada um vira um item da barra) e cores de identidade
writeSnap(1, at - 60_000);
const fresh2 = core.readLimits(at, lim);
const seg = core.render(b, at, allOpts, fresh2);
assert.ok(seg.segments.five.startsWith('5h 12%') && seg.segments.week.startsWith('7d 49%'));
assert.ok(seg.segments.main.includes('/1M') && seg.segments.tail.includes('US$'));
assert.deepStrictEqual(seg.warn, { main: false, five: false, week: false });
assert.strictEqual(core.normalizeColor('#4fc1ff'), '#4fc1ff');
assert.strictEqual(core.normalizeColor('charts.blue'), 'charts.blue');
assert.strictEqual(core.normalizeColor('red;background:url(x)'), null);
assert.strictEqual(core.normalizeColor(''), null);
const html = core.renderPanel(b, at, { ...allOpts, colorFive: '#4fc1ff', colorWeek: 'charts.purple' }, fresh2);
assert.ok(html.includes('background:#4fc1ff;') && html.includes('var(--vscode-charts-purple)'));
// leitura com 16 min: ainda vale (limite de 30), mas mostra a idade
writeSnap(1, at - 16 * 60_000);
const aged = core.readLimits(at, { snapshotPath: snapFile, staleMinutes: 30 });
assert.strictEqual(aged.stale, false);
const agedView = core.render(b, at, allOpts, aged);
assert.ok(agedView.segments.five.endsWith('(há 16m)'), agedView.segments.five);
assert.ok(core.renderPanel(b, at, allOpts, aged).includes('leitura há 16m'));
writeSnap(1, at - 60_000);
assert.ok(!core.render(b, at, allOpts, core.readLimits(at, lim)).segments.five.includes('há'), 'leitura recente não mostra idade');
// pedido de atualização à meter: só com leitura velha e no máximo a cada 5 min
const L = ageMs => ({ ageMs });
assert.strictEqual(core.shouldNudge(L(2 * 60_000), 1_000_000, 0), false, 'leitura recente não pede');
assert.strictEqual(core.shouldNudge(L(7 * 60_000), 1_000_000, 0), true);
assert.strictEqual(core.shouldNudge(L(7 * 60_000), 1_000_000, 1_000_000 - 60_000), false, 'respeita o intervalo');
assert.strictEqual(core.shouldNudge(null, 1_000_000, 0), true, 'sem snapshot também pede');
// consulta direta: formato da resposta, recuo e escolha da leitura mais recente
const body = { five_hour: { utilization: 22.4, resets_at: '2026-01-01T13:00:00Z' }, seven_day: { utilization: 51, resets_at: 1767312000 } };
const direct = core.parseUsageBody(body, at);
assert.strictEqual(direct.session.percent, 22);
assert.strictEqual(direct.session.resetsAt, Date.parse('2026-01-01T13:00:00Z'));
assert.strictEqual(direct.weekly.resetsAt, 1767312000 * 1000, 'resets_at em segundos vira ms');
assert.strictEqual(direct.source, 'direto');
assert.strictEqual(core.parseUsageBody({}, at), null);
assert.strictEqual(core.parseUsageBody({ five_hour: { utilization: -1 } }, at), null);

const base5 = 5 * 60_000;
assert.strictEqual(core.nextPollDelay({ status: 200, failures: 0 }, base5), base5);
assert.strictEqual(core.nextPollDelay({ status: 401, failures: 1 }, base5), 15 * 60_000);
assert.strictEqual(core.nextPollDelay({ status: 429, retryAfterMs: 20 * 60_000, failures: 1 }, base5), 20 * 60_000, 'respeita Retry-After');
assert.strictEqual(core.nextPollDelay({ status: 429, failures: 10 }, base5), 60 * 60_000, 'recuo limitado a 60 min');
assert.strictEqual(core.nextPollDelay({ status: 0, failures: 10 }, base5), 30 * 60_000);

const oldMeter = core.withAge({ session: { percent: 14, resetsAt: null }, weekly: null, receivedAt: at - 26 * 60_000, source: 'meter' }, at, 30);
const fresh3 = core.withAge(direct, at, 30);
assert.strictEqual(core.pickLimits(oldMeter, fresh3).session.percent, 22, 'a leitura mais recente vence');
assert.strictEqual(core.pickLimits(oldMeter, null), oldMeter);
assert.strictEqual(core.pickLimits(null, null), null);
assert.ok(core.render(b, at, allOpts, fresh3).tooltip.includes('direto da API'));
// degradê de cor por uso: base até 50%, âmbar em 75%, vermelho a partir de 90%
{
  const ramp = core.rampOf({});
  assert.deepStrictEqual(ramp, { start: 50, amber: 75, red: 90 });
  assert.strictEqual(core.rampOf({ colorGradient: false }), null);
  assert.deepStrictEqual(core.rampOf({ colorGradientStart: 80, colorGradientAmber: 70 }), { start: 50, amber: 75, red: 90 }, 'ordem inválida volta ao padrão');
  assert.deepStrictEqual(core.rampOf({ colorGradientStart: 20, colorGradientAmber: 40, colorGradientRed: 150 }), { start: 20, amber: 40, red: 100 }, 'valores são limitados a 0–100');

  assert.strictEqual(core.usageColor(0, '#3794ff', ramp), '#3794ff');
  assert.strictEqual(core.usageColor(50, '#3794ff', ramp), '#3794ff');
  assert.strictEqual(core.usageColor(62.5, '#3794ff', ramp), '#8e9d85', 'meio caminho entre a base e o âmbar');
  assert.strictEqual(core.usageColor(75, '#3794ff', ramp), '#e5a50a');
  assert.strictEqual(core.usageColor(82.5, '#3794ff', ramp), '#eb792b', 'meio caminho entre o âmbar e o vermelho');
  assert.strictEqual(core.usageColor(90, '#3794ff', ramp), '#f14c4c');
  assert.strictEqual(core.usageColor(100, '#3794ff', ramp), '#f14c4c');
  assert.strictEqual(core.usageColor(140, '#3794ff', ramp), '#f14c4c', 'acima de 100 continua vermelho');

  // id de cor do tema: vale até o início do degradê; depois é misturado pelo hex aproximado
  assert.strictEqual(core.usageColor(30, 'charts.blue', ramp), 'charts.blue');
  assert.strictEqual(core.usageColor(62.5, 'charts.blue', ramp), '#8e9d85');
  assert.strictEqual(core.usageColor(60, 'charts.desconhecido', ramp), 'charts.desconhecido', 'sem hex conhecido, mantém a cor até o âmbar');
  assert.strictEqual(core.usageColor(95, 'charts.desconhecido', ramp), '#f14c4c');
  assert.strictEqual(core.usageColor(62.5, '#fff', ramp), core.usageColor(62.5, '#ffffff', ramp), 'hex curto equivale ao longo');

  // sem cor-base (contexto): cor padrão até o âmbar, depois âmbar → vermelho
  assert.strictEqual(core.usageColor(0, undefined, ramp), undefined);
  assert.strictEqual(core.usageColor(75, undefined, ramp), undefined);
  assert.strictEqual(core.usageColor(82.5, undefined, ramp), '#eb792b');
  assert.strictEqual(core.usageColor(95, undefined, ramp), '#f14c4c');

  // a cor nunca "salta": passos de 1% mudam pouco (sem contar a entrada do âmbar sem base)
  const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  for (let p = 50; p < 100; p++) {
    const a = core.usageColor(p, '#3794ff', ramp);
    const b2 = core.usageColor(p + 1, '#3794ff', ramp);
    // O azul → âmbar é o trecho mais íngreme: 245 de diferença no canal azul em 25 passos (~10 por passo).
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(channel(a, i) - channel(b2, i)) <= 11, `salto de cor entre ${p}% e ${p + 1}%: ${a} → ${b2}`);
  }

  const lim95 = core.withAge({ session: { percent: 95, resetsAt: at + 3_600_000 }, weekly: { percent: 62, resetsAt: at + 86_400_000 }, receivedAt: at - 60_000, source: 'direto' }, at, 30);
  const gv = core.render(b, at, { ...allOpts, colorFive: 'charts.blue', colorWeek: 'charts.blue' }, lim95);
  assert.strictEqual(gv.colors.five, '#f14c4c');
  assert.notStrictEqual(gv.colors.week, 'charts.blue', 'semanal a 62% já saiu da cor-base');
  assert.strictEqual(gv.warn.five, true);
  assert.strictEqual(gv.warn.week, false);
  const off = core.render(b, at, { ...allOpts, colorGradient: false, colorFive: 'charts.blue' }, lim95);
  assert.strictEqual(off.colors, null, 'sem degradê o render não devolve cores calculadas');
  assert.strictEqual(off.warn.five, true, 'alerta de 90% continua valendo sem degradê');
  const custom = core.render(b, at, { ...allOpts, colorGradientStart: 10, colorGradientAmber: 20, colorGradientRed: 60, colorFive: '#3794ff' }, lim95);
  assert.strictEqual(custom.warn.week, true, 'o alerta acompanha onde o vermelho começa (60%)');

  const panelOn = core.renderPanel(b, at, { ...allOpts, colorFive: 'charts.blue', colorWeek: 'charts.blue' }, lim95);
  assert.ok(panelOn.includes('background:#f14c4c'), 'barra de 95% fica vermelha no painel');
  assert.ok(!/class="fill (ok|mid|hi)"/.test(panelOn), 'com degradê o painel não usa as faixas fixas');
  const panelOff = core.renderPanel(b, at, { ...allOpts, colorGradient: false, colorFive: 'charts.blue', colorWeek: 'charts.blue' }, lim95);
  assert.ok(panelOff.includes('class="fill hi"'), 'sem degradê vale o comportamento anterior');
}

// consulta direta: uma por máquina, cache compartilhado, recuo e credencial vencida
const directMod = require('../lib/usage/direct');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cub-direct-'));
  const okBody = { five_hour: { utilization: 22, resets_at: '2026-01-01T13:00:00Z' }, seven_day: { utilization: 51, resets_at: '2026-01-02T00:00:00Z' } };
  let calls = 0;
  const fakeFetch = (status, body, headers = {}) => async () => {
    calls++;
    await new Promise(r => setTimeout(r, 20));
    return { status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body };
  };
  const cred = async () => ({ token: 't', expiresAt: null });
  const base = 5 * 60_000;

  // duas janelas ao mesmo tempo: só uma consulta
  const [a, b2] = await Promise.all([
    directMod.poll({ baseMs: base, dir, fetchImpl: fakeFetch(200, okBody), credentials: cred }),
    directMod.poll({ baseMs: base, dir, fetchImpl: fakeFetch(200, okBody), credentials: cred }),
  ]);
  assert.strictEqual(calls, 1, 'trava entre janelas');
  assert.ok(a !== b2);
  const shared = directMod.readShared(Date.now(), 30, dir);
  assert.strictEqual(shared.limits.session.percent, 22);
  assert.strictEqual(shared.limits.source, 'direto');

  // dentro do intervalo, ninguém consulta de novo
  assert.strictEqual(await directMod.poll({ baseMs: base, dir, fetchImpl: fakeFetch(200, okBody), credentials: cred }), false);
  assert.strictEqual(calls, 1);

  // 429: mantém a leitura anterior, registra o erro e respeita o Retry-After
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cub-direct-'));
  await directMod.poll({ baseMs: base, dir: dir2, fetchImpl: fakeFetch(200, okBody), credentials: cred });
  const store2 = JSON.parse(fs.readFileSync(path.join(dir2, 'usage.json'), 'utf8'));
  fs.writeFileSync(path.join(dir2, 'usage.json'), JSON.stringify({ ...store2, nextPollAt: 0 }));
  const before = Date.now();
  await directMod.poll({ baseMs: base, dir: dir2, fetchImpl: fakeFetch(429, null, { 'retry-after': '1200' }), credentials: cred });
  const after429 = JSON.parse(fs.readFileSync(path.join(dir2, 'usage.json'), 'utf8'));
  assert.strictEqual(after429.limits.session.percent, 22, 'leitura anterior preservada');
  assert.ok(after429.lastError.includes('429'));
  assert.ok(after429.nextPollAt - before >= 20 * 60_000 - 1000, 'Retry-After de 20 min respeitado');

  // credencial vencida: não chama a API
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cub-direct-'));
  calls = 0;
  await directMod.poll({ baseMs: base, dir: dir3, fetchImpl: fakeFetch(200, okBody), credentials: async () => ({ token: 't', expiresAt: Date.now() + 60_000 }) });
  assert.strictEqual(calls, 0, 'token prestes a vencer não é usado');
  assert.ok(directMod.readShared(Date.now(), 30, dir3).lastError.includes('vencido'));

  // trava abandonada há mais de 60 s é retomada
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'cub-direct-'));
  fs.writeFileSync(path.join(dir4, 'poll.lock'), JSON.stringify({ at: Date.now() - 120_000 }));
  assert.ok(directMod.acquireLock(dir4, Date.now()), 'trava velha expira');
  assert.strictEqual(directMod.acquireLock(dir4, Date.now()), null, 'trava nova bloqueia');

  assert.strictEqual(directMod.parseRetryAfter('120', 0), 120_000);
  assert.strictEqual(directMod.parseRetryAfter(null, 0), null);
  assert.deepStrictEqual(core.parseCredentials('{"claudeAiOauth":{"accessToken":"x","expiresAt":5}}'), { token: 'x', expiresAt: 5 });
  assert.ok(core.parseCredentials('lixo').error);
  const panelOff = core.renderPanel(b, at, { ...allOpts, fetchLimitsDirectly: false }, null);
  assert.ok(panelOff.includes('command:claudeUsageBar.enableDirect'));
  assert.ok(core.renderPanel(b, at, { ...allOpts, fetchLimitsDirectly: true, directError: 'falha de rede' }, null).includes('Último erro: falha de rede'));

  // uso do Claude depois da leitura: consulta antes dos 5 min, mas respeitando 1 min de espaçamento
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'cub-direct-'));
  calls = 0;
  const t0 = Date.now();
  await directMod.poll({ baseMs: base, dir: dir5, now: t0, fetchImpl: fakeFetch(200, okBody), credentials: cred });
  assert.strictEqual(calls, 1);
  await directMod.poll({ baseMs: base, minGapMs: 60_000, wantFresh: true, dir: dir5, now: t0 + 30_000, fetchImpl: fakeFetch(200, okBody), credentials: cred });
  assert.strictEqual(calls, 1, 'antes de 1 min não consulta, mesmo com uso');
  await directMod.poll({ baseMs: base, minGapMs: 60_000, wantFresh: false, dir: dir5, now: t0 + 90_000, fetchImpl: fakeFetch(200, okBody), credentials: cred });
  assert.strictEqual(calls, 1, 'sem uso, espera os 5 min');
  await directMod.poll({ baseMs: base, minGapMs: 60_000, wantFresh: true, dir: dir5, now: Date.now() + 90_000, fetchImpl: fakeFetch(200, okBody), credentials: cred });
  assert.strictEqual(calls, 2, 'com uso, consulta após 1 min');
  // durante recuo por erro, o uso não antecipa a consulta
  const s5 = JSON.parse(fs.readFileSync(path.join(dir5, 'usage.json'), 'utf8'));
  fs.writeFileSync(path.join(dir5, 'usage.json'), JSON.stringify({ ...s5, failures: 1, nextPollAt: Date.now() + 3_600_000, lastAttemptAt: 0 }));
  await directMod.poll({ baseMs: base, minGapMs: 60_000, wantFresh: true, dir: dir5, fetchImpl: fakeFetch(200, okBody), credentials: cred });
  assert.strictEqual(calls, 2, 'recuo respeitado');
  // janela que reiniciou sem leitura nova: mostra "–" em vez de sumir
  const restarted = { session: { percent: 40, resetsAt: at - 1000 }, weekly: { percent: 16, resetsAt: at + 86_400_000 }, receivedAt: at - 60_000, source: 'direto' };
  const rv = core.render(b, at, allOpts, core.withAge(restarted, at, 30));
  assert.strictEqual(rv.segments.five, '5h –');
  assert.ok(rv.segments.week.startsWith('7d 16%'));
  assert.ok(core.renderPanel(b, at, allOpts, core.withAge(restarted, at, 30)).includes('Janela reiniciada'));
  // em ingles (idioma padrao) a mesma mensagem sai no texto-fonte
  i18n.setLanguage('en');
  core.setTranslator(i18n.t, 'en-US');
  assert.ok(core.renderPanel(b, at, allOpts, core.withAge(restarted, at, 30)).includes('Window restarted'));
  assert.ok(core.render(b, at, allOpts, null).tooltip.includes('current session'));
  i18n.setLanguage('pt');
  console.log('ok');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
