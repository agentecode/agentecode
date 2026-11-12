/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Historico de uso e custo: soma, por dia, projeto e modelo, o que os transcripts do Claude Code
// ja registraram em ~/.claude/projects. Logica pura (sem VS Code); o custo usa a mesma tabela da barra de uso.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { messageCost, messageCostParts } = require('./usage/core');
const { limitsByDay } = require('./usageLimitsLog');

const CACHE_VERSION = 3;
/** Conversas apagadas continuam no arquivo de totais por este tempo (ms). */
const KEEP_GONE_MS = 730 * 24 * 3600 * 1000;
/** Quantas respostas mais caras ficam guardadas por arquivo e dia. */
const TOP_REPLIES = 5;

/** @returns {string} Pasta de dados do Claude Code. */
function claudeDirOf() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Dia local (YYYY-MM-DD) de um instante em ms.
 * @param {number} ms
 * @returns {string}
 */
function localDay(ms) {
	const d = new Date(ms);
	const mm = `${d.getMonth() + 1}`.padStart(2, '0');
	const dd = `${d.getDate()}`.padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * @typedef {{ t: number, usd: number, context: number, model: string }} Reply
 * @typedef {{ usd: number, input: number, output: number, cacheRead: number, cacheWrite: number, unpriced: boolean, replies: number, contextSum: number, contextMax: number, models: Record<string, number>, parts: { input: number, output: number, cacheRead: number, cacheWrite: number }, hours: number[], top: Reply[] }} DayTotals
 * @typedef {{ cwd: string | null, title: string | null, firstTs: number | null, lastTs: number | null, days: Record<string, DayTotals> }} FileData
 */

/**
 * Le um transcript (.jsonl) e soma as respostas do assistente por dia local.
 * @param {string} file
 * @returns {Promise<FileData>}
 */
async function scanFile(file) {
	const msgs = new Map();
	let cwd = null;
	let title = null;
	let firstPrompt = null;
	let firstTs = null;
	let lastTs = null;

	const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
	for await (const line of rl) {
		// linhas de ferramenta e de resultado sao enormes e nao interessam: so interpreta as que podem ter uso, titulo, pasta ou o primeiro pedido
		if (!line || !(line.includes('"usage"') || line.includes('"ai-title"') || cwd === null || (firstPrompt === null && line.includes('"type":"user"')))) {
			continue;
		}
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (!cwd && typeof rec.cwd === 'string') {
			cwd = rec.cwd;
		}
		const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
		if (!Number.isNaN(t)) {
			firstTs = firstTs === null ? t : Math.min(firstTs, t);
			lastTs = lastTs === null ? t : Math.max(lastTs, t);
		}
		if (rec.type === 'ai-title' && rec.aiTitle) {
			title = rec.aiTitle;
		} else if (firstPrompt === null && rec.type === 'user' && !rec.isMeta && !rec.isSidechain && rec.message) {
			const c = rec.message.content;
			const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join(' ') : '';
			if (text.trim()) {
				firstPrompt = text.trim().split('\n')[0].slice(0, 80);
			}
		}
		const m = rec.message;
		if (rec.type === 'assistant' && m && m.usage && m.model !== '<synthetic>' && !Number.isNaN(t)) {
			// mesma resposta pode aparecer mais de uma vez no arquivo; a ultima leitura vale
			msgs.set(m.id || rec.uuid, { t, model: m.model, usage: m.usage });
		}
	}

	/** @type {Record<string, DayTotals>} */
	const days = {};
	for (const { t, model, usage: u } of msgs.values()) {
		const key = localDay(t);
		const day = days[key] || (days[key] = { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpriced: false, replies: 0, contextSum: 0, contextMax: 0, models: {}, parts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, hours: new Array(24).fill(0), top: [] });
		const context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
		day.replies++;
		day.contextSum += context;
		day.contextMax = Math.max(day.contextMax, context);
		const cost = messageCost(model, u);
		if (cost === null) {
			day.unpriced = true;
		} else {
			day.usd += cost;
			day.models[model] = (day.models[model] || 0) + cost;
			const parts = messageCostParts(model, u);
			if (parts) {
				for (const k of Object.keys(day.parts)) {
					day.parts[k] += parts[k];
				}
			}
			day.hours[new Date(t).getHours()] += cost;
			day.top.push({ t, usd: cost, context, model });
			day.top.sort((a, b) => b.usd - a.usd);
			day.top.length = Math.min(day.top.length, TOP_REPLIES);
		}
		day.input += u.input_tokens || 0;
		day.output += u.output_tokens || 0;
		day.cacheRead += u.cache_read_input_tokens || 0;
		day.cacheWrite += u.cache_creation_input_tokens || 0;
	}
	return { cwd, title: title || firstPrompt, firstTs, lastTs, days };
}

/**
 * Lista os transcripts de todos os projetos (sessoes principais e subagentes).
 * @param {string} claudeDir
 * @returns {Promise<{ project: string, session: string, file: string, isSub: boolean }[]>}
 */
async function listTranscripts(claudeDir) {
	const root = path.join(claudeDir, 'projects');
	const out = [];
	let projects;
	try {
		projects = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const proj of projects) {
		if (!proj.isDirectory()) {
			continue;
		}
		const dir = path.join(root, proj.name);
		let entries;
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isFile() && e.name.endsWith('.jsonl')) {
				out.push({ project: proj.name, session: e.name.replace(/\.jsonl$/, ''), file: path.join(dir, e.name), isSub: false });
			} else if (e.isDirectory()) {
				const subDir = path.join(dir, e.name, 'subagents');
				let subs = [];
				try {
					subs = (await fs.promises.readdir(subDir)).filter(n => n.endsWith('.jsonl'));
				} catch {
					// sessao sem subagentes
				}
				for (const n of subs) {
					out.push({ project: proj.name, session: e.name, file: path.join(subDir, n), isSub: true });
				}
			}
		}
	}
	return out;
}

/**
 * Le o cache de resumos por arquivo (so reprocessa o que mudou).
 * @param {string | undefined} cacheFile
 * @returns {Promise<Record<string, { size: number, mtimeMs: number, data: FileData }>>}
 */
async function loadCache(cacheFile) {
	if (!cacheFile) {
		return {};
	}
	try {
		const parsed = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
		return parsed && parsed.version === CACHE_VERSION && parsed.files ? parsed.files : {};
	} catch {
		return {};
	}
}

async function saveCache(cacheFile, files) {
	if (!cacheFile) {
		return;
	}
	try {
		await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
		const tmp = `${cacheFile}.tmp`;
		await fs.promises.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, files }), 'utf8');
		await fs.promises.rename(tmp, cacheFile);
	} catch {
		// cache e so otimizacao
	}
}

/**
 * Carrega o historico de todos os transcripts, usando o arquivo de totais para o que nao mudou.
 * Conversa que o Claude Code ou o usuario apagou continua valendo: o resumo guardado fica, marcado como `gone`.
 * @param {{ claudeDir?: string, cacheFile?: string, now?: number, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<{ project: string, session: string, isSub: boolean, gone: boolean, data: FileData }[]>}
 */
async function loadHistory(options = {}) {
	const claudeDir = options.claudeDir || claudeDirOf();
	const now = options.now ?? Date.now();
	const list = await listTranscripts(claudeDir);
	const cache = await loadCache(options.cacheFile);
	const nextCache = {};
	const entries = [];
	const present = new Set(list.map(item => item.file));
	let done = 0;

	for (const item of list) {
		let st;
		try {
			st = await fs.promises.stat(item.file);
		} catch {
			continue;
		}
		let cached = cache[item.file];
		if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
			try {
				cached = { size: st.size, mtimeMs: st.mtimeMs, data: await scanFile(item.file) };
			} catch {
				continue;
			}
		}
		cached = { size: cached.size, mtimeMs: cached.mtimeMs, data: cached.data, meta: { project: item.project, session: item.session, isSub: item.isSub } };
		nextCache[item.file] = cached;
		entries.push({ project: item.project, session: item.session, isSub: item.isSub, gone: false, data: cached.data });
		done++;
		if (options.onProgress && done % 25 === 0) {
			options.onProgress(done, list.length);
		}
	}

	// arquivos que sumiram desde a ultima leitura: o que ja foi somado fica guardado
	for (const [file, cached] of Object.entries(cache)) {
		if (present.has(file) || !cached.meta) {
			continue;
		}
		const goneAt = cached.goneAt ?? now;
		if (now - goneAt > KEEP_GONE_MS) {
			continue;
		}
		nextCache[file] = { ...cached, goneAt };
		entries.push({ project: cached.meta.project, session: cached.meta.session, isSub: cached.meta.isSub, gone: true, data: cached.data });
	}
	await saveCache(options.cacheFile, nextCache);
	return entries;
}

/**
 * Nome amigavel do projeto: ultima pasta do cwd gravado no transcript (ou o nome codificado da pasta).
 * @param {string} dirName
 * @param {string | null} cwd
 * @returns {string}
 */
function projectName(dirName, cwd) {
	if (cwd) {
		const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
		if (base) {
			return base;
		}
	}
	return dirName.replace(/^-+/, '') || dirName;
}

/** Totais de um intervalo de dias locais (chaves YYYY-MM-DD, inclusive). */
function totalsBetween(entries, from, to) {
	const r = { usd: 0, replies: 0, contextSum: 0, output: 0, tokens: 0 };
	for (const { data } of entries) {
		for (const [key, v] of Object.entries(data.days)) {
			if (key >= from && key <= to) {
				r.usd += v.usd;
				r.replies += v.replies || 0;
				r.contextSum += v.contextSum || 0;
				r.output += v.output;
				r.tokens += v.input + v.output + v.cacheRead + v.cacheWrite;
			}
		}
	}
	return r;
}

/**
 * Periodo escolhido contra o periodo de mesmo tamanho logo antes. `partial` avisa que o anterior pode estar incompleto,
 * porque o Claude Code apaga conversas antigas e os dados mais velhos so existem se ja estavam guardados.
 */
function comparePeriods(entries, now, days) {
	const dayAt = back => {
		const d = new Date(now);
		d.setDate(d.getDate() - back);
		return localDay(d.getTime());
	};
	const current = { from: dayAt(days - 1), to: dayAt(0) };
	const previous = { from: dayAt(days * 2 - 1), to: dayAt(days) };
	let firstDay = null;
	for (const { data } of entries) {
		for (const key of Object.keys(data.days)) {
			if (firstDay === null || key < firstDay) {
				firstDay = key;
			}
		}
	}
	return {
		current: { ...current, ...totalsBetween(entries, current.from, current.to) },
		previous: { ...previous, ...totalsBetween(entries, previous.from, previous.to) },
		firstDay,
		partial: firstDay === null || firstDay > previous.from
	};
}

/** Conversas apagadas cujo uso ainda esta somado (e quanto). */
function goneSummary(entries, dayKeys) {
	const range = new Set(dayKeys);
	const sessions = new Set();
	let usd = 0;
	for (const { project, session, gone, data } of entries) {
		if (!gone) {
			continue;
		}
		for (const [key, v] of Object.entries(data.days)) {
			if (range.has(key)) {
				usd += v.usd;
				sessions.add(`${project}/${session}`);
			}
		}
	}
	return { sessions: sessions.size, usd };
}

/** Limites 5h/7d guardados, ao lado do custo estimado de cada dia do periodo. */
function limitsSummary(samples, byDay) {
	if (!samples || samples.length === 0) {
		return { days: [], samples: 0 };
	}
	const perDay = limitsByDay(samples);
	const days = byDay
		.filter(d => perDay.has(d.date))
		.map(d => {
			const l = perDay.get(d.date);
			return { date: d.date, usd: d.usd, fiveMax: l.fiveMax, weeklyDelta: l.weeklyDelta, weeklyEnd: l.weeklyEnd, perPoint: l.weeklyDelta >= 1 ? d.usd / l.weeklyDelta : null };
		});
	return { days, samples: samples.length, since: samples[0].t };
}

/**
 * Soma o historico para exibicao.
 * @param {{ project: string, session: string, isSub: boolean, data: FileData }[]} entries
 * @param {{ now: number, days: number, detailDay?: string, limitSamples?: import('./usageLimitsLog').LimitSample[] }} options
 *   `detailDay` (YYYY-MM-DD): dia detalhado, padrao hoje; `limitSamples`: leituras guardadas dos limites 5h/7d
 */
function summarize(entries, { now, days, detailDay, limitSamples }) {
	const dayKeys = [];
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(now);
		d.setDate(d.getDate() - i);
		dayKeys.push(localDay(d.getTime()));
	}
	const inRange = new Set(dayKeys);

	const byDay = new Map(dayKeys.map(k => [k, { date: k, usd: 0, tokens: 0 }]));
	const byProject = new Map();
	const byModel = new Map();
	let unpriced = false;

	// totais fixos (independentes do periodo escolhido)
	const startOf = n => {
		const d = new Date(now);
		d.setDate(d.getDate() - (n - 1));
		return localDay(d.getTime());
	};
	const today = localDay(now);
	const week = startOf(7);
	const month = startOf(30);
	const totals = { today: 0, week: 0, month: 0, range: 0, tokens: 0, sessions: 0 };
	const sessionsSeen = new Set();

	// detalhe de um dia: por tipo de uso, por conversa, por hora e as respostas mais caras
	const detailKey = detailDay && /^\d{4}-\d{2}-\d{2}$/.test(detailDay) ? detailDay : today;
	const titles = new Map();
	for (const { project, session, isSub, data } of entries) {
		if (!isSub && data.title) {
			titles.set(`${project}/${session}`, data.title);
		}
	}
	const detail = { date: detailKey, usd: 0, tokens: 0, replies: 0, contextSum: 0, contextMax: 0, goneUsd: 0, parts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokensByPart: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, hours: new Array(24).fill(0), sessions: [], top: [] };
	const detailSessions = new Map();

	for (const { project, session, isSub, gone, data } of entries) {
		const name = projectName(project, data.cwd);
		const dayDetail = data.days[detailKey];
		if (dayDetail) {
			detail.usd += dayDetail.usd;
			detail.tokens += dayDetail.input + dayDetail.output + dayDetail.cacheRead + dayDetail.cacheWrite;
			detail.replies += dayDetail.replies || 0;
			detail.contextSum += dayDetail.contextSum || 0;
			detail.contextMax = Math.max(detail.contextMax, dayDetail.contextMax || 0);
			detail.goneUsd += gone ? dayDetail.usd : 0;
			for (const k of Object.keys(detail.parts)) {
				detail.parts[k] += (dayDetail.parts && dayDetail.parts[k]) || 0;
				detail.tokensByPart[k] += dayDetail[k] || 0;
			}
			(dayDetail.hours || []).forEach((usd, hour) => { detail.hours[hour] += usd; });
			const id = `${project}/${session}`;
			const row = detailSessions.get(id) || { title: titles.get(id) || null, project: name, usd: 0, subUsd: 0, tokens: 0, gone: true };
			row.gone = row.gone && Boolean(gone);
			row.usd += dayDetail.usd;
			row.subUsd += isSub ? dayDetail.usd : 0;
			row.tokens += dayDetail.input + dayDetail.output + dayDetail.cacheRead + dayDetail.cacheWrite;
			detailSessions.set(id, row);
			for (const r of dayDetail.top || []) {
				detail.top.push({ ...r, title: titles.get(id) || null, project: name, isSub, gone: Boolean(gone) });
			}
		}
		for (const [key, v] of Object.entries(data.days)) {
			if (key === today) {
				totals.today += v.usd;
			}
			if (key >= week && key <= today) {
				totals.week += v.usd;
			}
			if (key >= month && key <= today) {
				totals.month += v.usd;
			}
			if (!inRange.has(key)) {
				continue;
			}
			const tokens = v.input + v.output + v.cacheRead + v.cacheWrite;
			const d = byDay.get(key);
			d.usd += v.usd;
			d.tokens += tokens;
			totals.range += v.usd;
			totals.tokens += tokens;
			unpriced = unpriced || v.unpriced;

			const p = byProject.get(project) || { name, usd: 0, tokens: 0, sessions: new Set() };
			p.usd += v.usd;
			p.tokens += tokens;
			p.sessions.add(session);
			byProject.set(project, p);
			sessionsSeen.add(`${project}/${session}`);

			for (const [model, usd] of Object.entries(v.models)) {
				byModel.set(model, (byModel.get(model) || 0) + usd);
			}
		}
	}
	totals.sessions = sessionsSeen.size;
	const compare = comparePeriods(entries, now, days);
	const gone = goneSummary(entries, dayKeys);
	const limits = limitsSummary(limitSamples, Array.from(byDay.values()));
	detail.sessions = Array.from(detailSessions.values()).sort((a, b) => b.usd - a.usd);
	detail.top = detail.top.sort((a, b) => b.usd - a.usd).slice(0, TOP_REPLIES);

	return {
		days,
		detail,
		compare,
		gone,
		limits,
		byDay: Array.from(byDay.values()),
		byProject: Array.from(byProject.values())
			.map(p => ({ name: p.name, usd: p.usd, tokens: p.tokens, sessions: p.sessions.size }))
			.sort((a, b) => b.usd - a.usd),
		byModel: Array.from(byModel, ([model, usd]) => ({ model, usd })).sort((a, b) => b.usd - a.usd),
		totals,
		unpriced
	};
}

module.exports = {
	claudeDirOf,
	localDay,
	scanFile,
	listTranscripts,
	loadHistory,
	projectName,
	summarize
};
