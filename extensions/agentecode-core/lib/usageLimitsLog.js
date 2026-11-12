/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Registro dos percentuais dos limites de 5h e 7d da assinatura ao longo do tempo, para comparar semanas.
// A Anthropic so informa o valor de agora; aqui cada leitura fica guardada. Sem dependencia do editor.

const fs = require('fs');
const path = require('path');

/** Dia local (YYYY-MM-DD) de um instante em ms; o mesmo criterio do historico de custo. */
function localDay(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** Leituras iguais so entram de novo depois deste intervalo; mudancas entram sempre. */
const MIN_GAP_MS = 10 * 60 * 1000;
const MAX_SAMPLES = 30000;
const KEEP_MS = 400 * 24 * 3600 * 1000;
const WRITE_GAP_MS = 60 * 1000;

/**
 * @typedef {{ t: number, s: number | null, sr: number | null, w: number | null, wr: number | null }} LimitSample
 *   t: instante; s/sr: percentual e reinicio da janela de 5h; w/wr: idem da janela de 7 dias
 */

/**
 * Transforma o retrato dos limites (como a barra de uso o entende) em uma leitura do registro.
 * @param {{ session?: { percent: number, resetsAt: number | null } | null, weekly?: { percent: number, resetsAt: number | null } | null, stale?: boolean } | null} limits
 * @param {number} now
 * @returns {LimitSample | null}
 */
function sampleOf(limits, now) {
	if (!limits || limits.stale || (!limits.session && !limits.weekly)) {
		return null;
	}
	return {
		t: now,
		s: limits.session ? limits.session.percent : null,
		sr: limits.session ? limits.session.resetsAt : null,
		w: limits.weekly ? limits.weekly.percent : null,
		wr: limits.weekly ? limits.weekly.resetsAt : null
	};
}

/**
 * Acrescenta a leitura se ela mudou ou se ja passou tempo desde a ultima. Devolve a lista (a mesma, alterada) e se mudou.
 * @param {LimitSample[]} samples
 * @param {LimitSample | null} sample
 * @returns {boolean}
 */
function appendSample(samples, sample) {
	if (!sample) {
		return false;
	}
	const last = samples[samples.length - 1];
	if (last && last.s === sample.s && last.w === sample.w && last.sr === sample.sr && last.wr === sample.wr && sample.t - last.t < MIN_GAP_MS) {
		return false;
	}
	samples.push(sample);
	return true;
}

/**
 * Resumo por dia local: maior percentual de 5h e quanto a janela de 7 dias subiu naquele dia.
 * A subida soma so leituras consecutivas da mesma janela (mesmo horario de reinicio).
 * @param {LimitSample[]} samples
 * @returns {Map<string, { fiveMax: number | null, weeklyDelta: number, weeklyEnd: number | null, samples: number }>}
 */
function limitsByDay(samples) {
	const days = new Map();
	const day = key => {
		let d = days.get(key);
		if (!d) {
			d = { fiveMax: null, weeklyDelta: 0, weeklyEnd: null, samples: 0 };
			days.set(key, d);
		}
		return d;
	};
	let previous;
	for (const sample of samples) {
		const d = day(localDay(sample.t));
		d.samples++;
		if (sample.s !== null) {
			d.fiveMax = Math.max(d.fiveMax ?? 0, sample.s);
		}
		if (sample.w !== null) {
			d.weeklyEnd = sample.w;
			if (previous && previous.w !== null && previous.wr === sample.wr && sample.w > previous.w) {
				d.weeklyDelta += sample.w - previous.w;
			}
		}
		previous = sample;
	}
	return days;
}

/**
 * @param {string} file
 * @returns {LimitSample[]}
 */
function readLog(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		return Array.isArray(parsed && parsed.samples) ? parsed.samples.filter(s => s && typeof s.t === 'number') : [];
	} catch {
		return [];
	}
}

/**
 * Registro em disco: `record` guarda a leitura (gravando no maximo uma vez por minuto) e `samples` devolve o que ja existe.
 * @param {string} file
 */
function createLimitsLog(file) {
	/** @type {LimitSample[] | undefined} */
	let samples;
	let dirty = false;
	let lastWrite = 0;

	const ensure = () => samples ?? (samples = readLog(file));

	const flush = now => {
		if (!dirty) {
			return;
		}
		try {
			const list = ensure().filter(s => now - s.t < KEEP_MS).slice(-MAX_SAMPLES);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ version: 1, samples: list }), 'utf8');
			fs.renameSync(tmp, file);
			samples = list;
			dirty = false;
			lastWrite = now;
		} catch {
			// o registro e so um extra: falha de disco nao pode atrapalhar a barra de uso
		}
	};

	return {
		record(limits, now) {
			if (appendSample(ensure(), sampleOf(limits, now))) {
				dirty = true;
			}
			if (dirty && now - lastWrite >= WRITE_GAP_MS) {
				flush(now);
			}
		},
		flush: now => flush(now ?? Date.now()),
		samples: () => (dirty ? ensure() : readLog(file))
	};
}

module.exports = { sampleOf, appendSample, limitsByDay, readLog, createLimitsLog, MIN_GAP_MS };
