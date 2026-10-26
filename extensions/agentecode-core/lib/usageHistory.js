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
const { messageCost } = require('./usage/core');

const CACHE_VERSION = 1;

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
 * @typedef {{ usd: number, input: number, output: number, cacheRead: number, cacheWrite: number, unpriced: boolean, models: Record<string, number> }} DayTotals
 * @typedef {{ cwd: string | null, firstTs: number | null, lastTs: number | null, days: Record<string, DayTotals> }} FileData
 */

/**
 * Le um transcript (.jsonl) e soma as respostas do assistente por dia local.
 * @param {string} file
 * @returns {Promise<FileData>}
 */
async function scanFile(file) {
	const msgs = new Map();
	let cwd = null;
	let firstTs = null;
	let lastTs = null;

	const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line) {
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
		const day = days[key] || (days[key] = { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpriced: false, models: {} });
		const cost = messageCost(model, u);
		if (cost === null) {
			day.unpriced = true;
		} else {
			day.usd += cost;
			day.models[model] = (day.models[model] || 0) + cost;
		}
		day.input += u.input_tokens || 0;
		day.output += u.output_tokens || 0;
		day.cacheRead += u.cache_read_input_tokens || 0;
		day.cacheWrite += u.cache_creation_input_tokens || 0;
	}
	return { cwd, firstTs, lastTs, days };
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
 * Carrega o historico de todos os transcripts, usando o cache para o que nao mudou.
 * @param {{ claudeDir?: string, cacheFile?: string, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<{ project: string, session: string, isSub: boolean, data: FileData }[]>}
 */
async function loadHistory(options = {}) {
	const claudeDir = options.claudeDir || claudeDirOf();
	const list = await listTranscripts(claudeDir);
	const cache = await loadCache(options.cacheFile);
	const nextCache = {};
	const entries = [];
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
		nextCache[item.file] = cached;
		entries.push({ project: item.project, session: item.session, isSub: item.isSub, data: cached.data });
		done++;
		if (options.onProgress && done % 25 === 0) {
			options.onProgress(done, list.length);
		}
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

/**
 * Soma o historico para exibicao.
 * @param {{ project: string, session: string, isSub: boolean, data: FileData }[]} entries
 * @param {{ now: number, days: number }} options
 */
function summarize(entries, { now, days }) {
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

	for (const { project, session, data } of entries) {
		const name = projectName(project, data.cwd);
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

	return {
		days,
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
	localDay,
	scanFile,
	listTranscripts,
	loadHistory,
	projectName,
	summarize
};
