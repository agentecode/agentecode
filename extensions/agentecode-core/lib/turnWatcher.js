/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Percebe quando um novo pedido do usuario chega a uma conversa do Claude Code, olhando so o que foi acrescentado
// ao arquivo da conversa. Serve para tirar a foto do projeto no comeco de cada pedido. Sem VS Code.

const fs = require('fs');
const path = require('path');

/**
 * Pedidos reais do usuario dentro de entradas ja lidas de uma conversa (ignora resultados de ferramentas,
 * mensagens internas e subagentes).
 * @param {any[]} entries
 * @returns {{ uuid: string, timestamp?: string }[]}
 */
function detectPrompts(entries) {
	const prompts = [];
	for (const entry of entries) {
		if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain || !entry.uuid) {
			continue;
		}
		const content = entry.message?.content;
		let isPrompt = false;
		if (typeof content === 'string') {
			isPrompt = content.trim().length > 0;
		} else if (Array.isArray(content) && !content.some(block => block?.type === 'tool_result')) {
			isPrompt = content.some(block => block?.type === 'text' && String(block.text ?? '').trim().length > 0);
		}
		if (isPrompt) {
			prompts.push({ uuid: entry.uuid, timestamp: entry.timestamp });
		}
	}
	return prompts;
}

/**
 * Converte um trecho de texto lido do fim de um .jsonl em entradas; devolve tambem quantos bytes foram consumidos
 * (so linhas completas contam).
 * @param {Buffer} chunk
 * @returns {{ entries: any[], consumed: number }}
 */
function parseAppended(chunk) {
	const end = chunk.lastIndexOf(0x0a);
	if (end < 0) {
		return { entries: [], consumed: 0 };
	}
	const entries = [];
	for (const line of chunk.subarray(0, end + 1).toString('utf8').split('\n')) {
		if (!line) {
			continue;
		}
		try {
			entries.push(JSON.parse(line));
		} catch {
			// linha truncada
		}
	}
	return { entries, consumed: end + 1 };
}

class TurnWatcher {
	/**
	 * @param {string} dir Pasta das conversas do projeto (~/.claude/projects/<projeto>)
	 * @param {(sessionId: string, prompt: { uuid: string, timestamp?: string }) => void} onPrompt
	 */
	constructor(dir, onPrompt) {
		this.dir = dir;
		this.onPrompt = onPrompt;
		/** @type {Map<string, number>} bytes ja lidos de cada conversa */
		this.offsets = new Map();
		this.watcher = undefined;
		this.timer = undefined;
		this.running = false;
	}

	/** Comeca a observar: o que ja existe e historico, so o que for acrescentado dali em diante conta. */
	async start() {
		try {
			for (const name of await fs.promises.readdir(this.dir)) {
				if (name.endsWith('.jsonl')) {
					this.offsets.set(name, (await fs.promises.stat(path.join(this.dir, name))).size);
				}
			}
		} catch {
			// pasta ainda nao existe
		}
		try {
			this.watcher = fs.watch(this.dir, () => this.schedule());
			this.watcher.on('error', () => { });
		} catch {
			// sem observador: a checagem periodica abaixo cobre
		}
		this.timer = setInterval(() => this.schedule(), 5000);
	}

	schedule() {
		clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.check(), 150);
	}

	async check() {
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		try {
			let names = [];
			try {
				names = (await fs.promises.readdir(this.dir)).filter(n => n.endsWith('.jsonl'));
			} catch {
				return;
			}
			for (const name of names) {
				const file = path.join(this.dir, name);
				let size;
				try {
					size = (await fs.promises.stat(file)).size;
				} catch {
					continue;
				}
				const known = this.offsets.get(name) ?? 0;
				if (size < known) {
					this.offsets.set(name, 0);
					continue;
				}
				if (size === known) {
					continue;
				}
				const handle = await fs.promises.open(file, 'r');
				try {
					const buffer = Buffer.alloc(size - known);
					await handle.read(buffer, 0, buffer.length, known);
					const { entries, consumed } = parseAppended(buffer);
					this.offsets.set(name, known + consumed);
					for (const prompt of detectPrompts(entries)) {
						this.onPrompt(name.slice(0, -'.jsonl'.length), prompt);
					}
				} finally {
					await handle.close();
				}
			}
		} finally {
			this.running = false;
			if (this.again) {
				this.again = false;
				this.schedule();
			}
		}
	}

	dispose() {
		clearTimeout(this.debounce);
		clearInterval(this.timer);
		this.watcher?.close();
	}
}

module.exports = { TurnWatcher, detectPrompts, parseAppended };
