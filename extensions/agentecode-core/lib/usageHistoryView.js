/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { loadHistory, summarize, claudeDirOf } = require('./usageHistory');
const { readLog } = require('./usageLimitsLog');
const { t, getLanguage } = require('./i18n');

const RANGES = [7, 30, 90];

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const usd = n => `US$ ${n.toFixed(2)}`;
const formatTokens = n => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
const shortDate = key => `${key.slice(8, 10)}/${key.slice(5, 7)}`;

/**
 * Grafico de barras (SVG) do gasto por dia. Sem bibliotecas; cores seguem o tema.
 * @param {{ date: string, usd: number, tokens: number }[]} byDay
 * @param {string} today
 * @param {string} selected dia detalhado abaixo do grafico
 * @returns {string}
 */
function renderChart(byDay, today, selected) {
	const W = 720;
	const H = 180;
	const padL = 44;
	const padB = 22;
	const padT = 8;
	const max = Math.max(0.01, ...byDay.map(d => d.usd));
	const plotW = W - padL - 6;
	const plotH = H - padB - padT;
	const slot = plotW / byDay.length;
	const barW = Math.max(1.5, slot * 0.72);

	const bars = byDay.map((d, i) => {
		const h = d.usd > 0 ? Math.max(1.5, (d.usd / max) * plotH) : 0;
		const x = padL + i * slot + (slot - barW) / 2;
		const y = padT + plotH - h;
		const cls = (d.date === today ? 'bar today' : 'bar') + (d.date === selected ? ' picked' : '');
		return `<g class="day" data-day="${esc(d.date)}"><title>${esc(shortDate(d.date))}: ${usd(d.usd)} (${esc(t('{0} tokens', formatTokens(d.tokens)))}) - ${esc(t('Click for the details of this day'))}</title>` +
			`<rect class="hit" x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}"/>` +
			`<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"/></g>`;
	}).join('');

	const labelEvery = Math.ceil(byDay.length / 8);
	const labels = byDay.map((d, i) => (i % labelEvery === 0 || i === byDay.length - 1)
		? `<text class="axis" x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(shortDate(d.date))}</text>` : '').join('');

	return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('Spending per day'))}">` +
		`<line class="grid" x1="${padL}" y1="${padT}" x2="${W - 6}" y2="${padT}"/>` +
		`<line class="grid" x1="${padL}" y1="${padT + plotH / 2}" x2="${W - 6}" y2="${padT + plotH / 2}"/>` +
		`<line class="grid" x1="${padL}" y1="${padT + plotH}" x2="${W - 6}" y2="${padT + plotH}"/>` +
		`<text class="axis" x="${padL - 6}" y="${padT + 4}" text-anchor="end">${esc(max.toFixed(max >= 10 ? 0 : 2))}</text>` +
		`<text class="axis" x="${padL - 6}" y="${padT + plotH + 4}" text-anchor="end">0</text>` +
		bars + labels + '</svg>';
}

/**
 * Tabela com barra proporcional ao gasto.
 * @param {{ label: string, usd: number, extra?: string }[]} rows
 * @returns {string}
 */
function renderShareTable(rows) {
	if (rows.length === 0) {
		return `<div class="sub">${esc(t('Nothing in this period.'))}</div>`;
	}
	const max = Math.max(0.0001, ...rows.map(r => r.usd));
	return '<table class="share">' + rows.map(r =>
		`<tr><td class="name">${esc(r.label)}</td><td class="meter"><span style="width:${Math.max(2, (r.usd / max) * 100).toFixed(0)}%"></span></td>` +
		`<td class="num">${usd(r.usd)}</td><td class="extra">${esc(r.extra || '')}</td></tr>`).join('') + '</table>';
}

/**
 * Grafico de barras do gasto por hora do dia (0h a 23h).
 * @param {number[]} hours
 * @returns {string}
 */
function renderHours(hours) {
	const W = 720;
	const H = 110;
	const padL = 44;
	const padB = 18;
	const padT = 6;
	const max = Math.max(0.01, ...hours);
	const plotH = H - padB - padT;
	const slot = (W - padL - 6) / 24;
	const bars = hours.map((v, h) => {
		const bh = v > 0.004 ? Math.max(1.5, (v / max) * plotH) : 0;
		const x = padL + h * slot + slot * 0.14;
		return `<g><title>${String(h).padStart(2, '0')}h: ${usd(v)}</title><rect class="bar hour" x="${x.toFixed(1)}" y="${(padT + plotH - bh).toFixed(1)}" width="${(slot * 0.72).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"/></g>` +
			(h % 3 === 0 ? `<text class="axis" x="${(padL + h * slot + slot / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${h}h</text>` : '');
	}).join('');
	return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('By hour'))}">` +
		`<line class="grid" x1="${padL}" y1="${padT + plotH}" x2="${W - 6}" y2="${padT + plotH}"/>` +
		`<text class="axis" x="${padL - 6}" y="${padT + 4}" text-anchor="end">${esc(max.toFixed(max >= 10 ? 0 : 2))}</text>` + bars + '</svg>';
}

/** Dia no formato "12/11" (ou "hoje"). */
const dayLabel = (key, today) => (key === today ? `${shortDate(key)} (${t('today')})` : shortDate(key));

/**
 * Detalhe de um dia: por tipo de uso, por conversa, por hora e as respostas mais caras.
 * @param {ReturnType<typeof summarize>['detail']} detail
 * @param {string} today
 * @returns {string}
 */
function renderDetail(detail, today) {
	if (detail.usd <= 0) {
		return `<h2>${esc(t('Details of {0}', dayLabel(detail.date, today)))}</h2><div class="sub">${esc(t('Nothing spent on this day.'))}</div>`;
	}
	const share = usdValue => `${Math.round((usdValue / detail.usd) * 100)}%`;
	const typeRows = [
		['cacheRead', t('Cache read (earlier context re-read on every reply)')],
		['cacheWrite', t('Cache write (new context stored)')],
		['input', t('New input')],
		['output', t('Output (what Claude wrote)')]
	].map(([key, label]) => ({ label, usd: detail.parts[key], extra: `${share(detail.parts[key])} · ${t('{0} tokens', formatTokens(detail.tokensByPart[key]))}` }));
	const sessionRows = detail.sessions.slice(0, 8).map(r => ({
		label: r.title || t('Untitled session'),
		usd: r.usd,
		extra: [r.gone ? t('deleted') : '', r.subUsd > 0.005 ? t('{0} · agents {1}', r.project, usd(r.subUsd)) : r.project].filter(Boolean).join(' · ')
	}));
	const topRows = detail.top.map(r => ({
		label: `${new Date(r.t).toTimeString().slice(0, 5)} · ${r.title || t('Untitled session')}`,
		usd: r.usd,
		extra: `${t('context {0}', formatTokens(r.context))}${r.isSub ? ' · ' + t('agent') : ''}${r.gone ? ' · ' + t('deleted') : ''}`
	}));
	const stat = (label, value) => `<div class="tile small"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
	const replies = Math.max(1, detail.replies);
	const stats = `<div class="tiles">${stat(t('Replies'), `${detail.replies}`)}${stat(t('Average per reply'), usd(detail.usd / replies))}${stat(t('Average context'), formatTokens(Math.round(detail.contextSum / replies)))}${stat(t('Largest context'), formatTokens(detail.contextMax))}${stat(t('Tokens'), formatTokens(detail.tokens))}</div>`;
	const goneNote = detail.goneUsd > 0.005 ? `<div class="sub">${esc(t('{0} of this day comes from deleted conversations, kept in the totals.', usd(detail.goneUsd)))}</div>` : '';
	return `<h2>${esc(t('Details of {0}', dayLabel(detail.date, today)))} · ${usd(detail.usd)}</h2>
<div class="sub">${esc(t('Click a bar in the chart to see another day.'))}</div>
${stats}${goneNote}
<h3>${esc(t('Where the cost comes from'))}</h3>
${renderShareTable(typeRows)}
<h3>${esc(t('By conversation'))}</h3>
${renderShareTable(sessionRows)}
<h3>${esc(t('By hour'))}</h3>
${renderHours(detail.hours)}
<h3>${esc(t('Most expensive replies'))}</h3>
<div class="sub">${esc(t('A reply costs more when the conversation context is large, because all of it is read again.'))}</div>
${renderShareTable(topRows)}`;
}

/** Variacao em porcentagem entre dois valores, com a cor da direcao (mais gasto = vermelho). */
function change(current, previous) {
	if (!previous) {
		return `<td class="num">-</td>`;
	}
	const pct = Math.round(((current - previous) / previous) * 100);
	return `<td class="num ${pct > 5 ? 'up' : pct < -5 ? 'down' : ''}">${pct > 0 ? '+' : ''}${pct}%</td>`;
}

/**
 * Periodo escolhido contra o periodo de mesmo tamanho logo antes.
 * @param {ReturnType<typeof summarize>['compare']} compare
 * @param {number} days
 * @returns {string}
 */
function renderCompare(compare, days) {
	const c = compare.current;
	const p = compare.previous;
	const per = (x, v) => (x.replies ? v / x.replies : 0);
	const rows = [
		[t('Cost'), usd(c.usd), usd(p.usd), c.usd, p.usd],
		[t('Replies'), `${c.replies}`, `${p.replies}`, c.replies, p.replies],
		[t('Cost per reply'), usd(per(c, c.usd)), usd(per(p, p.usd)), per(c, c.usd), per(p, p.usd)],
		[t('Average context'), formatTokens(Math.round(per(c, c.contextSum))), formatTokens(Math.round(per(p, p.contextSum))), per(c, c.contextSum), per(p, p.contextSum)],
		[t('Output per reply'), formatTokens(Math.round(per(c, c.output))), formatTokens(Math.round(per(p, p.output))), per(c, c.output), per(p, p.output)]
	].map(([label, now, before, a, b]) => `<tr><td class="name">${esc(label)}</td><td class="num">${esc(now)}</td><td class="num sub">${esc(before)}</td>${change(a, b)}</tr>`).join('');
	const note = compare.partial ? `<div class="sub warn">${esc(t('The previous period may be incomplete: Claude Code deletes old conversations, and the data here starts on {0}.', compare.firstDay ? shortDate(compare.firstDay) : '-'))}</div>` : '';
	return `<h2>${esc(t('Compared with the previous {0} days', days))}</h2>
<table class="share compare"><tr><th></th><th>${esc(shortDate(c.from))} - ${esc(shortDate(c.to))}</th><th>${esc(shortDate(p.from))} - ${esc(shortDate(p.to))}</th><th></th></tr>${rows}</table>${note}`;
}

/**
 * Percentuais dos limites 5h/7d guardados a cada leitura, ao lado do custo estimado de cada dia.
 * @param {ReturnType<typeof summarize>['limits']} limits
 * @returns {string}
 */
function renderLimits(limits) {
	const head = `<h2>${esc(t('Subscription limits over time'))}</h2>`;
	if (limits.days.length === 0) {
		return `${head}<div class="sub">${esc(t('Recording started now. The 5h and 7d percentages are saved on every reading, so after a few days of use you can compare weeks here.'))}</div>`;
	}
	const rows = limits.days.slice(-14).map(d => `<tr><td class="name">${esc(shortDate(d.date))}</td>` +
		`<td class="num">${usd(d.usd)}</td>` +
		`<td class="num">${d.fiveMax === null ? '-' : `${d.fiveMax}%`}</td>` +
		`<td class="num">${d.weeklyDelta > 0 ? `+${d.weeklyDelta}%` : '0%'}${d.weeklyEnd === null ? '' : ` <span class="sub">(${d.weeklyEnd}%)</span>`}</td>` +
		`<td class="num">${d.perPoint === null ? '-' : usd(d.perPoint)}</td></tr>`).join('');
	return `${head}<div class="sub">${esc(t('Since {0}. US$ per point is the estimated cost divided by how much the weekly limit rose that day: if it falls from one week to the next, the same work is using more of the limit.', new Date(limits.since).toLocaleDateString()))}</div>
<table class="share compare"><tr><th></th><th>${esc(t('Cost'))}</th><th>${esc(t('5h peak'))}</th><th>${esc(t('7d rise'))}</th><th>${esc(t('US$ per point'))}</th></tr>${rows}</table>`;
}

/**
 * Monta o HTML completo da tela de historico.
 * @param {ReturnType<typeof summarize>} summary
 * @param {{ today: string, nonce: string, cspSource: string }} options
 * @returns {string}
 */
function renderHistoryHtml(summary, { today, nonce, cspSource }) {
	const totals = summary.totals;
	const tile = (label, value) => `<div class="tile"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
	const buttons = RANGES.map(n => `<button data-days="${n}" class="${n === summary.days ? 'on' : ''}">${esc(t('{0} days', n))}</button>`).join('');

	return `<!doctype html><html lang="${getLanguage() === 'pt' ? 'pt-BR' : 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:8px 22px 28px;max-width:860px}
h1{font-size:18px;font-weight:600;margin:14px 0 4px}
h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;margin:26px 0 10px;color:var(--vscode-descriptionForeground)}
.sub{color:var(--vscode-descriptionForeground);font-size:12px}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.tile{flex:1 1 120px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:6px;padding:10px 12px;background:var(--vscode-editorWidget-background)}
.tile .v{font-size:20px;font-weight:600}.tile .l{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}
.range{display:flex;gap:6px;margin-top:14px}
button{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-button-secondaryBackground,var(--vscode-widget-border));border-radius:4px;padding:3px 12px;cursor:pointer;font:inherit}
button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
svg{width:100%;height:auto;display:block}
.bar{fill:var(--vscode-charts-green)}.bar.today{fill:var(--vscode-charts-blue)}.bar.picked{stroke:var(--vscode-foreground);stroke-width:1.5}.bar.hour{fill:var(--vscode-charts-orange,var(--vscode-charts-green))}
.day{cursor:pointer}
.tile.small{flex:1 1 90px;padding:7px 10px}.tile.small .v{font-size:15px}
table.compare th{font-weight:600;font-size:11px;color:var(--vscode-descriptionForeground);text-align:right;padding:4px 6px}
td.up{color:var(--vscode-charts-red)}td.down{color:var(--vscode-charts-green)}
.warn{margin-top:6px;color:var(--vscode-editorWarning-foreground)}
h3{font-size:13px;font-weight:600;margin:18px 0 6px}
.hit{fill:transparent}.hit:hover+.bar{opacity:.75}
.grid{stroke:var(--vscode-widget-border,var(--vscode-panel-border));stroke-width:1;stroke-dasharray:3 3}
.axis{fill:var(--vscode-descriptionForeground);font-size:10px}
table.share{width:100%;border-collapse:collapse}
table.share td{padding:5px 6px;border-bottom:1px solid var(--vscode-widget-border,transparent)}
td.name{width:34%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}
td.meter{width:34%}td.meter span{display:block;height:8px;border-radius:4px;background:var(--vscode-charts-green)}
td.num{text-align:right;white-space:nowrap}td.extra{color:var(--vscode-descriptionForeground);font-size:12px;text-align:right;white-space:nowrap}
.note{margin-top:26px;font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.5}
</style></head><body>
<h1>${esc(t('Usage and cost history'))}</h1>
<div class="sub">${esc(t('Calculated from the conversations stored on this computer (includes subagents).'))}</div>
${summary.gone.sessions > 0 ? `<div class="sub">${esc(t('Includes {0} deleted conversation(s), {1}, kept from before they were removed.', summary.gone.sessions, usd(summary.gone.usd)))}</div>` : ''}
<div class="range">${buttons}</div>
<div class="tiles">${tile(t('Today'), usd(totals.today))}${tile(t('Last 7 days'), usd(totals.week))}${tile(t('Last 30 days'), usd(totals.month))}${tile(t('Period ({0} days)', summary.days), usd(totals.range))}${tile(t('Sessions in the period'), `${totals.sessions}`)}</div>
<h2>${esc(t('Spending per day'))}</h2>
${renderChart(summary.byDay, today, summary.detail.date)}
${renderDetail(summary.detail, today)}
${renderCompare(summary.compare, summary.days)}
${renderLimits(summary.limits)}
<h2>${esc(t('By project'))}</h2>
${renderShareTable(summary.byProject.slice(0, 12).map(p => ({ label: p.name, usd: p.usd, extra: t('{0} session(s) · {1} tokens', p.sessions, formatTokens(p.tokens)) })))}
<h2>${esc(t('By model'))}</h2>
${renderShareTable(summary.byModel.map(m => ({ label: m.model, usd: m.usd })))}
<div class="note">${t('Values estimated from the API price table using the transcripts; {0}.', `<b>${esc(t('they are not the billed amount'))}</b>`)} ${esc(t('On a subscription, usage is limited by the 5h and 7d windows (see the usage bar).'))}${summary.unpriced ? ' ' + esc(t('Some responses from models with no known price were left out of the total.')) : ''} ${esc(t('Only conversations still present on this computer are shown.'))}</div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('button[data-days]').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({type:'range',days:Number(b.dataset.days)})));document.querySelectorAll('.day').forEach(g=>g.addEventListener('click',()=>vscode.postMessage({type:'day',date:g.dataset.day})));</script>
</body></html>`;
}

/** @param {string} body */
function loadingHtml(body) {
	return `<!doctype html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px"><p>${esc(body)}</p></body></html>`;
}

/**
 * Mantem o arquivo de totais atualizado em segundo plano: cada vez que o Claude Code grava numa conversa, o resumo dela e
 * relido (com pequena espera). Assim o custo de uma conversa apagada depois ja esta guardado.
 * @param {() => Promise<unknown>} load leitura do historico (uma de cada vez)
 * @returns {import('vscode').Disposable}
 */
function watchTranscripts(load) {
	const root = path.join(claudeDirOf(), 'projects');
	let timer;
	let disposed = false;
	const schedule = delay => {
		if (disposed) {
			return;
		}
		clearTimeout(timer);
		timer = setTimeout(() => { void load().catch(() => undefined); }, delay);
	};
	let watcher;
	try {
		watcher = fs.watch(root, { recursive: true }, () => schedule(20_000));
		watcher.on('error', () => undefined);
	} catch {
		// sem observacao de pasta (ex.: pasta ainda nao existe): a leitura periodica abaixo cobre
	}
	const interval = setInterval(() => schedule(1000), 5 * 60 * 1000);
	schedule(8000);
	return {
		dispose() {
			disposed = true;
			clearTimeout(timer);
			clearInterval(interval);
			if (watcher) {
				watcher.close();
			}
		}
	};
}

/** @param {import('vscode').ExtensionContext} context */
function registerUsageHistory(context) {
	let panel;
	let days = 30;
	/** Dia detalhado (YYYY-MM-DD); `undefined` = hoje. */
	let detailDay;
	const cacheFile = path.join(context.globalStorageUri.fsPath, 'usage-history-cache.json');
	const limitsFile = path.join(context.globalStorageUri.fsPath, 'usage-limits-log.json');

	// uma leitura de cada vez: a tela e a leitura em segundo plano gravam o mesmo arquivo de totais
	let queue = Promise.resolve();
	const load = () => {
		const next = queue.then(() => loadHistory({ cacheFile }));
		queue = next.then(() => undefined, () => undefined);
		return next;
	};
	context.subscriptions.push(watchTranscripts(load));

	const refresh = async () => {
		if (!panel) {
			return;
		}
		const target = panel;
		target.webview.html = loadingHtml(t('Calculating the history (the first time may take a few seconds)...'));
		try {
			const entries = await load();
			if (panel !== target) {
				return;
			}
			const now = Date.now();
			const summary = summarize(entries, { now, days, detailDay, limitSamples: readLog(limitsFile) });
			const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
			target.webview.html = renderHistoryHtml(summary, { today: summary.byDay[summary.byDay.length - 1].date, nonce, cspSource: target.webview.cspSource });
		} catch (err) {
			if (panel === target) {
				target.webview.html = loadingHtml(t('Could not read the history: {0}', err && err.message ? err.message : err));
			}
		}
	};

	context.subscriptions.push(vscode.commands.registerCommand('agentecode.usage.history', async () => {
		if (panel) {
			panel.reveal();
		} else {
			panel = vscode.window.createWebviewPanel('agentecode.usageHistory', t('Usage history'), vscode.ViewColumn.Active, { enableScripts: true });
			panel.onDidDispose(() => { panel = undefined; });
			panel.webview.onDidReceiveMessage(msg => {
				if (msg && msg.type === 'range' && RANGES.includes(msg.days)) {
					days = msg.days;
					void refresh();
				} else if (msg && msg.type === 'day' && typeof msg.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(msg.date)) {
					detailDay = msg.date;
					void refresh();
				}
			});
		}
		await refresh();
	}));
}

module.exports = { registerUsageHistory, renderHistoryHtml };
