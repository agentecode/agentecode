/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const path = require('path');
const vscode = require('vscode');
const { loadHistory, summarize } = require('./usageHistory');
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
 * @returns {string}
 */
function renderChart(byDay, today) {
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
		const cls = d.date === today ? 'bar today' : 'bar';
		return `<g><title>${esc(shortDate(d.date))}: ${usd(d.usd)} (${esc(t('{0} tokens', formatTokens(d.tokens)))})</title>` +
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
.bar{fill:var(--vscode-charts-green)}.bar.today{fill:var(--vscode-charts-blue)}
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
<div class="range">${buttons}</div>
<div class="tiles">${tile(t('Today'), usd(totals.today))}${tile(t('Last 7 days'), usd(totals.week))}${tile(t('Last 30 days'), usd(totals.month))}${tile(t('Period ({0} days)', summary.days), usd(totals.range))}${tile(t('Sessions in the period'), `${totals.sessions}`)}</div>
<h2>${esc(t('Spending per day'))}</h2>
${renderChart(summary.byDay, today)}
<h2>${esc(t('By project'))}</h2>
${renderShareTable(summary.byProject.slice(0, 12).map(p => ({ label: p.name, usd: p.usd, extra: t('{0} session(s) · {1} tokens', p.sessions, formatTokens(p.tokens)) })))}
<h2>${esc(t('By model'))}</h2>
${renderShareTable(summary.byModel.map(m => ({ label: m.model, usd: m.usd })))}
<div class="note">${t('Values estimated from the API price table using the transcripts; {0}.', `<b>${esc(t('they are not the billed amount'))}</b>`)} ${esc(t('On a subscription, usage is limited by the 5h and 7d windows (see the usage bar).'))}${summary.unpriced ? ' ' + esc(t('Some responses from models with no known price were left out of the total.')) : ''} ${esc(t('Only conversations still present on this computer are shown.'))}</div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('button[data-days]').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({type:'range',days:Number(b.dataset.days)})));</script>
</body></html>`;
}

/** @param {string} body */
function loadingHtml(body) {
	return `<!doctype html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px"><p>${esc(body)}</p></body></html>`;
}

/** @param {import('vscode').ExtensionContext} context */
function registerUsageHistory(context) {
	let panel;
	let days = 30;
	const cacheFile = path.join(context.globalStorageUri.fsPath, 'usage-history-cache.json');

	const refresh = async () => {
		if (!panel) {
			return;
		}
		const target = panel;
		target.webview.html = loadingHtml(t('Calculating the history (the first time may take a few seconds)...'));
		try {
			const entries = await loadHistory({ cacheFile });
			if (panel !== target) {
				return;
			}
			const now = Date.now();
			const summary = summarize(entries, { now, days });
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
				}
			});
		}
		await refresh();
	}));
}

module.exports = { registerUsageHistory, renderHistoryHtml };
