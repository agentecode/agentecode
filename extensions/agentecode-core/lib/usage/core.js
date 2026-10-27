/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Cópia de github.com/AlessandroLobo/claude-usage-statusbar (MIT, versão 0.10.0); a fonte do código fica lá.

'use strict';

// Lógica pura (sem dependência do VS Code): localiza o transcript da sessão do
// Claude Code, lê só o que foi acrescentado desde a última leitura e calcula as métricas.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Textos em inglês; quem usa esta lógica pode injetar um tradutor (setTranslator) cujos {0}, {1}... recebem os argumentos.
const fill = (text, args) => (args.length ? text.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m)) : text);
let translate = (s, ...args) => fill(s, args);
let locale = 'en-US';

// `fn`: (texto em inglês, ...argumentos) => texto traduzido; `loc`: idioma de datas e números (ex.: 'pt-BR').
function setTranslator(fn, loc) {
  translate = fn || ((s, ...args) => fill(s, args));
  locale = loc || 'en-US';
}

// USD por 1M de tokens. `cr` = cache read; escrita de cache = 1.25x (5m) e 2x (1h) do input.
// Haiku 5.5 usa outra tabela quando o prompt passa de 100K tokens.
const PRICES = [
  { re: /fable|mythos/, in: 10, out: 50, cr: 0.25 },
  { re: /opus-5-5/, in: 4, out: 20, cr: 0.2 },
  { re: /opus-(5|4-[5-9])(?!\d)/, in: 5, out: 25 },
  { re: /opus/, in: 15, out: 75 },
  { re: /sonnet-5/, in: 2, out: 10 },
  { re: /sonnet/, in: 3, out: 15 },
  { re: /haiku-5/, in: 0.1, out: 0.5, long: { in: 0.5, out: 2.5 } },
  { re: /haiku-4/, in: 1, out: 5 },
  { re: /haiku-3-5/, in: 0.8, out: 4 },
  { re: /haiku/, in: 0.25, out: 1.25 },
];

const priceFor = model => (model ? PRICES.find(p => p.re.test(model)) : undefined);

const messageCost = (model, u) => {
  const p = priceFor(model);
  if (!p) return null;
  const input = u.input_tokens || 0;
  const read = u.cache_read_input_tokens || 0;
  const written = u.cache_creation_input_tokens || 0;
  let w5 = written;
  let w1h = 0;
  if (u.cache_creation) {
    w5 = u.cache_creation.ephemeral_5m_input_tokens || 0;
    w1h = u.cache_creation.ephemeral_1h_input_tokens || 0;
    if (w5 + w1h === 0) w5 = written;
  }
  const card = p.long && input + read + written > 100_000 ? { ...p, ...p.long, cr: undefined } : p;
  const crPrice = card.cr ?? card.in * 0.1;
  return (
    (input * card.in + w5 * card.in * 1.25 + w1h * card.in * 2 + read * crPrice + (u.output_tokens || 0) * card.out) /
    1e6
  );
};

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const encodeProject = p => p.replace(/[^a-zA-Z0-9]/g, '-');

const newestJsonl = dir => {
  let best = null;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const file = path.join(dir, n);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs };
  }
  return best;
};

// Sessão mais recente dos projetos que correspondem às pastas abertas (ou de todos, sem pasta aberta).
const findSession = workspacePaths => {
  const root = path.join(claudeDir(), 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  const wanted = new Set(workspacePaths.map(p => encodeProject(p).toLowerCase()));
  const pool = workspacePaths.length ? dirs.filter(d => wanted.has(d.toLowerCase())) : dirs;
  let best = null;
  for (const d of pool) {
    const n = newestJsonl(path.join(root, d));
    if (n && (!best || n.mtime > best.mtime)) best = n;
  }
  return best;
};

const DONE_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

const isRealPrompt = rec => {
  if (rec.isMeta || rec.toolUseResult) return false;
  const c = rec.message && rec.message.content;
  if (typeof c === 'string') return !/^<(command-|local-command)/.test(c.trimStart());
  if (!Array.isArray(c)) return false;
  return c.some(b => b.type === 'text') && !c.some(b => b.type === 'tool_result');
};

const newState = () => ({
  pos: 0,
  mtime: 0,
  msgs: new Map(),
  firstTs: null,
  lastTs: null,
  promptTs: null,
  assistantTs: null,
  kind: null,
  ctx: null,
  cost: null,
});

class Tracker {
  constructor() {
    this.files = new Map();
    this.sessionFile = null;
  }

  _readNew(file, main) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    let s = this.files.get(file);
    if (!s || st.size < s.pos) {
      s = newState();
      this.files.set(file, s);
    }
    s.mtime = st.mtimeMs;
    if (st.size === s.pos) return;

    const buf = Buffer.alloc(st.size - s.pos);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, s.pos);
    } finally {
      fs.closeSync(fd);
    }
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return;
    s.pos += end + 1;
    s.cost = null;
    for (const line of buf.subarray(0, end + 1).toString('utf8').split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      this._ingest(s, rec, main);
    }
  }

  _ingest(s, rec, main) {
    const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(t)) {
      if (s.firstTs === null) s.firstTs = t;
      s.lastTs = t;
    }
    const m = rec.message;
    if (rec.type === 'assistant' && m && m.usage) {
      if (m.model === '<synthetic>') return;
      s.msgs.set(m.id || rec.uuid, { model: m.model, usage: m.usage });
      if (main && !rec.isSidechain) {
        const u = m.usage;
        s.ctx = {
          model: m.model,
          tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0),
        };
        if (!Number.isNaN(t)) s.assistantTs = t;
        s.kind = DONE_REASONS.has(m.stop_reason) ? 'done' : 'busy';
      }
    } else if (main && rec.type === 'user' && !rec.isSidechain && !rec.isMeta) {
      if (isRealPrompt(rec) && !Number.isNaN(t)) s.promptTs = t;
      s.kind = 'busy';
    }
  }

  // Lê (incrementalmente) o transcript da sessão e os dos subagentes; devolve o retrato atual.
  update(sessionFile, now) {
    if (sessionFile !== this.sessionFile) {
      this.files.clear();
      this.sessionFile = sessionFile;
    }
    this._readNew(sessionFile, true);
    const subDir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
    let subs = [];
    try {
      subs = fs.readdirSync(subDir).filter(n => n.endsWith('.jsonl'));
    } catch {
      /* sem subagentes */
    }
    for (const n of subs) this._readNew(path.join(subDir, n), false);

    const main = this.files.get(sessionFile);
    let costUsd = 0;
    let unpriced = false;
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const s of this.files.values()) {
      if (s.cost === null) {
        s.cost = { usd: 0, unpriced: false, ...{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        for (const { model, usage: u } of s.msgs.values()) {
          const c = messageCost(model, u);
          if (c === null) s.cost.unpriced = true;
          else s.cost.usd += c;
          s.cost.input += u.input_tokens || 0;
          s.cost.output += u.output_tokens || 0;
          s.cost.cacheRead += u.cache_read_input_tokens || 0;
          s.cost.cacheWrite += u.cache_creation_input_tokens || 0;
        }
      }
      costUsd += s.cost.usd;
      unpriced = unpriced || s.cost.unpriced;
      totals.input += s.cost.input;
      totals.output += s.cost.output;
      totals.cacheRead += s.cost.cacheRead;
      totals.cacheWrite += s.cost.cacheWrite;
    }

    const running = main.kind === 'busy' && now - main.mtime < 120_000;
    let turnMs = null;
    if (main.promptTs !== null) {
      const end = running ? now : main.assistantTs;
      if (end !== null && end >= main.promptTs) turnMs = end - main.promptTs;
    }
    return {
      file: sessionFile,
      startedAt: main.firstTs,
      model: main.ctx ? main.ctx.model : null,
      ctxTokens: main.ctx ? main.ctx.tokens : null,
      costUsd,
      unpriced,
      totals,
      running,
      turnMs,
      lastActivityAt: main.assistantTs,
    };
  }
}

const contextWindow = (model, configured) => {
  if (configured > 0) return configured;
  if (model && /haiku-4|haiku-3|claude-3|opus-4-[01](?!\d)|opus-4-2025|sonnet-4-2025|sonnet-4-5/.test(model)) return 200_000;
  return 1_000_000;
};

const formatTokens = n =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

const formatElapsed = ms => {
  const min = Math.floor(ms / 60_000);
  if (min >= 1440) return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
  return min > 60 ? `${Math.floor(min / 60)}h${`${min % 60}`.padStart(2, '0')}` : `${min}m`;
};

const formatTurn = ms => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${`${s % 60}`.padStart(2, '0')}`;
};

// Limites de 5h/7d: lidos do snapshot compartilhado da extensão claude-usage-meter
// (sem rede e sem tocar em credenciais). Qualquer divergência de formato => sem limites.
const limitsSnapshotPath = override => override || path.join(os.homedir(), '.claude-usage-meter', 'usage-snapshot.json');

const withAge = (limits, now, staleMinutes) =>
  limits && {
    ...limits,
    ageMs: limits.receivedAt === null ? null : now - limits.receivedAt,
    stale: limits.receivedAt === null || now - limits.receivedAt > staleMinutes * 60_000,
  };

const readLimits = (now, { snapshotPath, staleMinutes }) => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(limitsSnapshotPath(snapshotPath), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || raw.v !== 1 || !raw.report) return null;
  const pick = w =>
    w && typeof w.utilization === 'number'
      ? { percent: Math.round(w.utilization), resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null }
      : null;
  const receivedAt = typeof raw.report.receivedAt === 'number' ? raw.report.receivedAt : null;
  return withAge({ session: pick(raw.report.session), weekly: pick(raw.report.weekly), receivedAt, source: 'meter' }, now, staleMinutes);
};

const toMs = v => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

// Resposta de /api/oauth/usage: { five_hour: { utilization, resets_at }, seven_day: { ... } }.
const parseUsageBody = (body, receivedAt) => {
  if (!body || typeof body !== 'object') return null;
  const gauge = g =>
    g && typeof g.utilization === 'number' && Number.isFinite(g.utilization) && g.utilization >= 0
      ? { percent: Math.round(g.utilization), resetsAt: toMs(g.resets_at) }
      : null;
  const session = gauge(body.five_hour);
  const weekly = gauge(body.seven_day);
  return session || weekly ? { session, weekly, receivedAt, source: 'direto' } : null;
};

// Somente leitura: o token nunca é gravado, registrado nem enviado a outro destino que não a API da Anthropic.
const parseCredentials = text => {
  try {
    const oauth = JSON.parse(text).claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return { error: translate('Claude Code credential has no token') };
    return { token: oauth.accessToken, expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null };
  } catch {
    return { error: translate('Claude Code credential is unreadable') };
  }
};

const readCredentials = () => {
  try {
    return parseCredentials(fs.readFileSync(path.join(claudeDir(), '.credentials.json'), 'utf8'));
  } catch {
    return { error: translate('Claude Code credential not found (log in to Claude Code)') };
  }
};

// Quanto esperar até a próxima consulta direta, conforme o resultado da última.
const nextPollDelay = ({ status, retryAfterMs, failures }, baseMs) => {
  if (status === 200) return baseMs;
  if (status === 401 || status === 403) return 15 * 60_000;
  if (status === 429) return Math.min(60 * 60_000, Math.max(retryAfterMs || 0, baseMs * 2 ** Math.min(failures, 4)));
  return Math.min(30 * 60_000, baseMs * 2 ** Math.min(failures, 3));
};

// Entre duas leituras, vale a mais recente.
const pickLimits = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  return (b.receivedAt ?? -1) > (a.receivedAt ?? -1) ? b : a;
};

const formatRemaining = ms => {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min >= 1440) return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
  if (min >= 60) return `${Math.floor(min / 60)}h${`${min % 60}`.padStart(2, '0')}`;
  return `${min}m`;
};

const clock = ms => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

// Momento do reinício: "às 18:41" se for hoje, "ter. às 21:00" nos outros dias.
const resetClock = (resetsAt, now) => {
  const d = new Date(resetsAt);
  if (d.toDateString() === new Date(now).toDateString()) return translate('at {0}', clock(resetsAt));
  return translate('{0} at {1}', d.toLocaleDateString(locale, { weekday: 'short' }), clock(resetsAt));
};

// Janela utilizável: leitura recente e ainda não reiniciada.
const liveWindow = (w, limits, now) => {
  if (!w || !limits || limits.stale) return null;
  if (w.resetsAt !== null && w.resetsAt <= now) return null;
  return w;
};

// Janela cuja leitura recente já passou do reinício: o valor antigo não vale e o novo ainda não chegou.
const restartedWindow = (w, limits, now) => Boolean(w && limits && !limits.stale && w.resetsAt !== null && w.resetsAt <= now);

const resetSuffix = (w, now) => (w.resetsAt === null ? '' : ` ↻${formatRemaining(w.resetsAt - now)}`);

// Leitura que já não é recente (a meter atualiza a cada ~5 min) vem com a idade ao lado.
const AGED_MS = 10 * 60_000;
const ageText = limits => (limits && limits.ageMs !== null && limits.ageMs >= AGED_MS ? translate('{0} ago', formatRemaining(limits.ageMs)) : '');
const ageSuffix = limits => (ageText(limits) ? ` (${ageText(limits)})` : '');

const render = (snap, now, opts, limits) => {
  const main = [];
  const tail = [];
  const lines = [`**Claude Code — ${translate('current session')}**`, '', '| | |', '|---|---|'];
  let warnMain = false;
  let warnFive = false;
  let warnWeek = false;
  let fiveText = null;
  let weekText = null;
  let ctxPct = null;
  // Com degradê o alerta (vermelho + fundo) começa onde o vermelho chega; sem ele valem 80% (contexto) e 90% (limites).
  const ramp = rampOf(opts);

  if (snap) {
    const window = contextWindow(snap.model, opts.contextWindow);
    if (opts.showSessionTime && snap.startedAt !== null) main.push(`$(clock) ${formatElapsed(now - snap.startedAt)}`);
    if (snap.ctxTokens !== null) {
      const pct = Math.round((snap.ctxTokens / window) * 100);
      ctxPct = pct;
      main.push(`${formatTokens(snap.ctxTokens)}/${formatTokens(window)} (${pct}%)`);
      warnMain = pct >= (ramp ? ramp.red : 80);
    } else {
      main.push(`–/${formatTokens(window)}`);
    }
  }

  const five = liveWindow(limits && limits.session, limits, now);
  const week = liveWindow(limits && limits.weekly, limits, now);
  if (opts.showLimits) {
    if (five) {
      fiveText = `5h ${five.percent}%${resetSuffix(five, now)}${ageSuffix(limits)}`;
      warnFive = five.percent >= (ramp ? ramp.red : 90);
    }
    if (!five && restartedWindow(limits && limits.session, limits, now)) fiveText = '5h –';
    if (!week && restartedWindow(limits && limits.weekly, limits, now)) weekText = '7d –';
    if (week) {
      weekText = `7d ${week.percent}%${resetSuffix(week, now)}${ageSuffix(limits)}`;
      warnWeek = week.percent >= (ramp ? ramp.red : 90);
    }
  }

  if (snap) {
    if (opts.showCost) tail.push(`US$ ${snap.costUsd.toFixed(2)}`);
    if (opts.showTurn && snap.turnMs !== null) tail.push(`${translate('turn {0}', formatTurn(snap.turnMs))}${snap.running ? ' ▶' : ''}`);
    const window = contextWindow(snap.model, opts.contextWindow);
    const t = snap.totals;
    lines.push(
      `| ${translate('Model')} | ${snap.model ?? '–'} |`,
      `| ${translate('Context')} | ${translate('{0} / {1} tokens', snap.ctxTokens === null ? '–' : snap.ctxTokens.toLocaleString(locale), window.toLocaleString(locale))} |`,
      `| ${translate('Estimated cost')} | US$ ${snap.costUsd.toFixed(4)}${snap.unpriced ? ` (${translate('a model has no known price')})` : ''} |`,
      `| ${translate('Tokens (total)')} | ${translate('in {0} · out {1} · cache read {2} · cache written {3}', formatTokens(t.input), formatTokens(t.output), formatTokens(t.cacheRead), formatTokens(t.cacheWrite))} |`,
    );
  }
  const remaining = w => (w.resetsAt === null ? '' : ` — ${translate('resets in {0} ({1})', formatRemaining(w.resetsAt - now), resetClock(w.resetsAt, now))}`);
  if (five) lines.push(`| ${translate('5h limit')} | ${five.percent}%${remaining(five)} |`);
  if (week) lines.push(`| ${translate('7d limit')} | ${week.percent}%${remaining(week)} |`);
  lines.push('');
  if (snap) lines.push(translate('Cost calculated from the transcript using the API price table (includes subagents); it is not the billed amount.'));
  if (limits && limits.receivedAt !== null) {
    lines.push(translate('Limits read {0} at {1}{2}.', limits.source === 'direto' ? translate('directly from the API') : translate('from claude-usage-meter'), clock(limits.receivedAt), limits.stale ? ` (${translate('outdated, not shown')})` : ''));
  }
  const segments = {
    main: main.length ? main.join(' · ') : null,
    five: fiveText,
    week: weekText,
    tail: tail.length ? tail.join(' · ') : null,
  };
  const all = [segments.main, segments.five, segments.week, segments.tail].filter(Boolean);
  // Cor de cada trecho conforme o uso (hex, id do tema ou undefined = cor padrão da barra); null sem degradê.
  const colorFive = normalizeColor(opts.colorFive) || undefined;
  const colorWeek = normalizeColor(opts.colorWeek) || undefined;
  const colors = ramp
    ? {
        main: ctxPct === null ? undefined : usageColor(ctxPct, undefined, ramp),
        five: five ? usageColor(five.percent, colorFive, ramp) : colorFive,
        week: week ? usageColor(week.percent, colorWeek, ramp) : colorWeek,
        tail: undefined,
      }
    : null;
  return {
    text: all.length ? all.join(' · ') : `$(clock) Claude: ${translate('no data')}`,
    segments,
    warn: { main: warnMain, five: warnFive, week: warnWeek },
    colors,
    tooltip: lines.join('\n'),
  };
};

// Aceita "#rgb"/"#rrggbb" ou id de cor do tema ("charts.blue"); qualquer outra coisa é ignorada.
const normalizeColor = v => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) || /^[a-zA-Z][a-zA-Z0-9.]*$/.test(s) ? s : null;
};

const cssColor = c => (c.startsWith('#') ? c : `var(--vscode-${c.replace(/\./g, '-')})`);

// Degradê por uso: cor própria até `start`%, depois mistura com âmbar (em `amber`%) e chega ao vermelho em `red`%.
const RAMP_DEFAULTS = { start: 50, amber: 75, red: 90 };
const AMBER = [229, 165, 10];
const RED = [241, 76, 76];
// Hex aproximado dos ids de cor do tema, só para poder misturar; até `start`% o id do tema continua valendo.
const THEME_HEX = {
  'charts.blue': '#3794ff',
  'charts.green': '#89d185',
  'charts.yellow': '#cca700',
  'charts.orange': '#d18616',
  'charts.purple': '#b180d7',
  'charts.red': '#f14c4c',
};

const parseHex = c => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c || '');
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, x => x + x) : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};
const toHex = rgb => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Faixas do degradê a partir das opções; null com `colorGradient: false`, e valores fora de ordem voltam ao padrão.
const rampOf = opts => {
  if (!opts || opts.colorGradient === false) return null;
  const n = (v, d) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : d);
  const r = { start: n(opts.colorGradientStart, RAMP_DEFAULTS.start), amber: n(opts.colorGradientAmber, RAMP_DEFAULTS.amber), red: n(opts.colorGradientRed, RAMP_DEFAULTS.red) };
  return r.start < r.amber && r.amber < r.red ? r : { ...RAMP_DEFAULTS };
};

// Cor para um uso de 0–100: `base` (id do tema ou hex) até `start`, depois âmbar e vermelho. Sem `base`, só colore a partir de `amber`.
const usageColor = (percent, base, ramp) => {
  const p = Math.min(100, Math.max(0, percent));
  if (p <= (base ? ramp.start : ramp.amber)) return base || undefined;
  if (p >= ramp.red) return toHex(RED);
  if (p >= ramp.amber) return toHex(mixRgb(AMBER, RED, (p - ramp.amber) / (ramp.red - ramp.amber)));
  const rgb = parseHex(THEME_HEX[base] || base);
  // Id de tema desconhecido não tem como ser misturado: mantém a cor até o âmbar.
  return rgb ? toHex(mixRgb(rgb, AMBER, (p - ramp.start) / (ramp.amber - ramp.start))) : base;
};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const barClass = p => (p >= 80 ? 'hi' : p >= 50 ? 'mid' : 'ok');

// Com degradê (`ramp`), barra e percentual seguem `usageColor`; sem `color`, o texto só se tinge a partir do âmbar.
// Sem degradê, título, percentual e barra usam a cor de identidade até 80%; acima disso vale a cor de alerta.
const barRow = (title, percent, note, color, ramp, baseWhenNone) => {
  if (ramp) {
    const c = usageColor(percent, color || baseWhenNone, ramp);
    const tint = c && (color || percent >= ramp.amber) ? ` style="color:${cssColor(c)}"` : '';
    return (
      `<div class="row"><div class="top"><span${tint}>${esc(title)}</span><span${tint}>${percent}%</span></div>` +
      `<div class="track"><div class="fill" style="background:${c ? cssColor(c) : 'var(--vscode-charts-green)'};width:${Math.min(100, Math.max(0, percent))}%"></div></div>` +
      `<div class="sub">${esc(note)}</div></div>`
    );
  }
  const own = color ? cssColor(color) : null;
  const alert = percent >= 80;
  const fill = own && !alert ? `background:${own};` : '';
  const ink = own ? ` style="color:${own}"` : '';
  return (
    `<div class="row"><div class="top"><span${ink}>${esc(title)}</span><span${ink}>${percent}%</span></div>` +
    `<div class="track"><div class="fill ${fill ? '' : barClass(percent)}" style="${fill}width:${Math.min(100, Math.max(0, percent))}%"></div></div>` +
    `<div class="sub">${esc(note)}</div></div>`
  );
};

// HTML do painel lateral (barras de uso). Sem scripts; atualizado trocando o HTML.
const renderPanel = (snap, now, opts, limits) => {
  const five = liveWindow(limits && limits.session, limits, now);
  const week = liveWindow(limits && limits.weekly, limits, now);
  const ramp = rampOf(opts);
  const resets = w => [w.resetsAt !== null ? translate('Resets in {0} ({1})', formatRemaining(w.resetsAt - now), resetClock(w.resetsAt, now)) : '', ageText(limits) ? translate('reading {0}', ageText(limits)) : ''].filter(Boolean).join(' · ');
  const body = [`<h2>${translate('Subscription usage')}</h2>`];

  const reiniciada = (titulo) =>
    `<div class="row"><div class="top"><span>${titulo}</span><span>–</span></div><div class="track"></div><div class="sub">${translate('Window restarted; waiting for the new reading.')}</div></div>`;
  const five0 = !five && restartedWindow(limits && limits.session, limits, now);
  const week0 = !week && restartedWindow(limits && limits.weekly, limits, now);
  if (five || week || five0 || week0) {
    if (five0) body.push(reiniciada(translate('Session (5h)')));
    if (week0) body.push(reiniciada(translate('Weekly (7 days)')));
    if (five) body.push(barRow(translate('Session (5h)'), five.percent, resets(five), normalizeColor(opts.colorFive), ramp));
    if (week) body.push(barRow(translate('Weekly (7 days)'), week.percent, resets(week), normalizeColor(opts.colorWeek), ramp));
  } else {
    const enable = `<a href="command:claudeUsageBar.enableDirect">${translate('enable the 5h/7d limits')}</a>`;
    const hint = opts.fetchLimitsDirectly
      ? `${translate('Waiting for the usage API query.')}${opts.directError ? ` ${translate('Last error: {0}.', esc(opts.directError))}` : ''}`
      : translate("Click to {0} (reads the Claude Code token and queries Anthropic's usage API).", enable);
    const why = `${limits && limits.stale ? translate('Limits reading is outdated (last at {0}).', clock(limits.receivedAt)) : translate('5h/7d limits unavailable.')} ${hint}`;
    body.push(`<div class="sub">${why}</div>`);
  }

  body.push(`<h2>${translate('Current session')}</h2>`);
  if (snap) {
    const window = contextWindow(snap.model, opts.contextWindow);
    if (snap.ctxTokens !== null) {
      const pct = Math.round((snap.ctxTokens / window) * 100);
      body.push(barRow(translate('Context'), pct, translate('{0} / {1} tokens', snap.ctxTokens.toLocaleString(locale), window.toLocaleString(locale)), null, ramp, 'charts.green'));
    }
    const kv = [[translate('Model'), snap.model ?? '–']];
    if (snap.startedAt !== null) kv.push([translate('Time'), formatElapsed(now - snap.startedAt)]);
    if (opts.showCost) kv.push([translate('Estimated cost'), `US$ ${snap.costUsd.toFixed(2)}`]);
    if (snap.turnMs !== null) kv.push([translate('Last turn'), `${formatTurn(snap.turnMs)}${snap.running ? ' ▶' : ''}`]);
    body.push(`<table>${kv.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`);
  } else {
    body.push(`<div class="sub">${translate('No Claude Code transcript found for this folder.')}</div>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:4px 14px 14px}
h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;margin:14px 0 10px;color:var(--vscode-descriptionForeground)}
.row{margin-bottom:14px}
.top{display:flex;justify-content:space-between;font-weight:600;margin-bottom:5px}
.track{height:6px;border-radius:3px;background:rgba(128,128,128,.3);overflow:hidden}
.fill{height:100%;border-radius:3px}
.ok{background:var(--vscode-charts-green,#89d185)}.mid{background:var(--vscode-charts-yellow,#cca700)}.hi{background:var(--vscode-charts-red,#f14c4c)}
.sub{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:5px;line-height:1.4}
a{color:var(--vscode-textLink-foreground)}
table{border-collapse:collapse;width:100%}td{padding:2px 0}td:first-child{color:var(--vscode-descriptionForeground);padding-right:12px;white-space:nowrap}td:last-child{text-align:right;word-break:break-all}
</style></head><body>${body.join('')}</body></html>`;
};

// Pede à claude-usage-meter uma leitura nova quando a atual envelheceu, no máximo uma vez por intervalo.
const NUDGE_AFTER_MS = 6 * 60_000;
const NUDGE_EVERY_MS = 5 * 60_000;
const shouldNudge = (limits, now, lastNudge) => {
  const age = limits && limits.ageMs !== null ? limits.ageMs : Infinity;
  return age >= NUDGE_AFTER_MS && now - lastNudge >= NUDGE_EVERY_MS;
};

module.exports = {
  setTranslator,
  shouldNudge,
  parseUsageBody,
  parseCredentials,
  readCredentials,
  nextPollDelay,
  pickLimits,
  withAge,
  Tracker,
  findSession,
  render,
  renderPanel,
  readLimits,
  messageCost,
  contextWindow,
  formatTokens,
  formatElapsed,
  formatTurn,
  formatRemaining,
  normalizeColor,
  rampOf,
  usageColor,
};
