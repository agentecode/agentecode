/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TurnWatcher, detectPrompts, parseAppended } = require('../lib/turnWatcher');

const user = (uuid, content, extra = {}) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-10-27T10:00:00Z', message: { content }, ...extra });

describe('Observador de pedidos ao agente', () => {
	test('detectPrompts ignora resultados de ferramentas, mensagens internas e subagentes', () => {
		const entries = [
			{ type: 'user', uuid: 'p1', message: { content: 'faca isso' } },
			{ type: 'user', uuid: 'p2', message: { content: [{ type: 'text', text: 'com imagem' }, { type: 'image' }] } },
			{ type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
			{ type: 'user', uuid: 'm1', isMeta: true, message: { content: 'interno' } },
			{ type: 'user', uuid: 's1', isSidechain: true, message: { content: 'subagente' } },
			{ type: 'user', uuid: 'v1', message: { content: '   ' } },
			{ type: 'assistant', uuid: 'a1', message: { content: 'resposta' } }
		];
		assert.deepEqual(detectPrompts(entries).map(p => p.uuid), ['p1', 'p2']);
	});

	test('parseAppended so consome linhas completas', () => {
		const full = Buffer.from(`${user('a', 'um')}\n${user('b', 'dois')}\n{"type":"user","uuid":"c"`);
		const { entries, consumed } = parseAppended(full);
		assert.equal(entries.length, 2);
		assert.equal(full.subarray(consumed).toString(), '{"type":"user","uuid":"c"');
	});

	test('o observador avisa so dos pedidos novos, nunca do historico', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-turns-'));
		const file = path.join(dir, 'sessao-1.jsonl');
		fs.writeFileSync(file, `${user('antigo', 'historico')}\n`);
		const seen = [];
		const watcher = new TurnWatcher(dir, (sessionId, prompt) => seen.push([sessionId, prompt.uuid]));
		try {
			await watcher.start();
			await watcher.check();
			assert.deepEqual(seen, [], 'historico nao conta');

			fs.appendFileSync(file, `${user('novo1', 'primeiro pedido')}\n${JSON.stringify({ type: 'assistant', uuid: 'x', message: { content: 'ok' } })}\n`);
			await watcher.check();
			assert.deepEqual(seen, [['sessao-1', 'novo1']]);

			fs.appendFileSync(file, user('parcial', 'meio'));
			await watcher.check();
			assert.equal(seen.length, 1, 'linha incompleta espera');
			fs.appendFileSync(file, '\n');
			await watcher.check();
			assert.deepEqual(seen.map(s => s[1]), ['novo1', 'parcial']);

			fs.writeFileSync(path.join(dir, 'sessao-2.jsonl'), `${user('outra', 'conversa nova')}\n`);
			await watcher.check();
			assert.deepEqual(seen.at(-1), ['sessao-2', 'outra']);
		} finally {
			watcher.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
