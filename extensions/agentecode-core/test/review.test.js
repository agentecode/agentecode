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

const review = require('../lib/review');

describe('Revisao do que o agente mudou', () => {
	let base;
	let project;
	let outsideFile;
	let sessionFile;
	const sessionId = 'abc12345-0000-0000-0000-000000000001';
	let previousEnv;

	before(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-review-'));
		previousEnv = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
		project = path.join(base, 'proj');
		fs.mkdirSync(project, { recursive: true });
		const history = path.join(base, 'claude', 'file-history', sessionId);
		fs.mkdirSync(history, { recursive: true });

		const modified = path.join(project, 'a.js');
		const added = path.join(project, 'novo.js');
		const deleted = path.join(project, 'apagado.js');
		const same = path.join(project, 'igual.js');
		outsideFile = path.join(base, 'fora.js');

		// estado de ANTES da primeira edicao
		fs.writeFileSync(path.join(history, 'aaaa@v1'), 'linha1\nlinha2\nlinha3\n');
		fs.writeFileSync(path.join(history, 'bbbb@v1'), 'conteudo que sera apagado\n');
		fs.writeFileSync(path.join(history, 'cccc@v1'), 'igual\n');
		fs.writeFileSync(path.join(history, 'dddd@v1'), 'fora\n');
		// estado de AGORA
		fs.writeFileSync(modified, 'linha1\nLINHA2 mudou\nlinha3\nlinha4\n');
		fs.writeFileSync(added, 'arquivo novo\n');
		fs.writeFileSync(same, 'igual\n');
		fs.writeFileSync(outsideFile, 'mudou fora\n');

		sessionFile = path.join(base, 'claude', 'projects', 'p', `${sessionId}.jsonl`);
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, [
			JSON.stringify({
				type: 'file-history-snapshot',
				messageId: 'm1',
				snapshot: {
					messageId: 'm1',
					timestamp: '2026-10-26T10:00:00Z',
					trackedFileBackups: {
						[modified]: { backupFileName: 'aaaa@v1' },
						[added]: { backupFileName: null },
						[deleted]: { backupFileName: 'bbbb@v1' },
						[same]: { backupFileName: 'cccc@v1' },
						[outsideFile]: { backupFileName: 'dddd@v1' }
					}
				}
			}),
			JSON.stringify({ type: 'file-history-snapshot', messageId: 'm2', snapshot: { messageId: 'm2', trackedFileBackups: { [modified]: { backupFileName: 'zzzz@v2' } } } })
		].join('\n') + '\n');
	});

	after(() => {
		if (previousEnv === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = previousEnv;
		}
		fs.rmSync(base, { recursive: true, force: true });
	});

	test('countLineChanges conta linhas acrescentadas e removidas', () => {
		assert.deepEqual(review.countLineChanges('a\nb\nc', 'a\nx\nc\nd'), { added: 2, removed: 1 });
		assert.deepEqual(review.countLineChanges('', 'a\nb'), { added: 2, removed: 0 });
		assert.deepEqual(review.countLineChanges('a\nb', ''), { added: 0, removed: 2 });
		assert.deepEqual(review.countLineChanges('igual', 'igual'), { added: 0, removed: 0 });
	});

	test('computeReview compara o estado de antes da primeira edicao com o disco', async () => {
		const result = await review.computeReview({ file: sessionFile, id: sessionId }, [project]);
		assert.equal(result.firstMessageId, 'm1');
		assert.equal(result.outside, 1, 'arquivo fora da pasta do projeto e ignorado');
		assert.deepEqual(
			result.items.map(i => [path.basename(i.file), i.status, i.added, i.removed]),
			[
				['a.js', 'modified', 2, 1],
				['apagado.js', 'deleted', 0, 1],
				['novo.js', 'added', 1, 0]
			]
		);
	});

	test('caminhos relativos a pasta da conversa sao resolvidos', async () => {
		const history = path.join(base, 'claude', 'file-history', 'rel-session');
		fs.mkdirSync(history, { recursive: true });
		fs.writeFileSync(path.join(history, 'eeee@v1'), 'antes\n');
		fs.writeFileSync(path.join(project, 'rel.js'), 'antes\ndepois\n');
		const file = path.join(base, 'claude', 'projects', 'p', 'rel-session.jsonl');
		fs.writeFileSync(file, JSON.stringify({
			type: 'file-history-snapshot',
			messageId: 'r1',
			snapshot: { messageId: 'r1', trackedFileBackups: { 'rel.js': { backupFileName: 'eeee@v1' } } }
		}) + '\n');
		const result = await review.computeReview({ file, id: 'rel-session', cwd: project }, [project]);
		assert.deepEqual(result.items.map(i => [i.file, i.status, i.added, i.removed]), [[path.join(project, 'rel.js'), 'modified', 1, 0]]);
		assert.equal(result.outside, 0);
	});

	test('sessao sem checkpoints nao tem alteracoes', async () => {
		const empty = path.join(base, 'claude', 'projects', 'p', 'vazia.jsonl');
		fs.writeFileSync(empty, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'oi' } }) + '\n');
		const result = await review.computeReview({ file: empty, id: 'vazia' }, [project]);
		assert.deepEqual(result, { firstMessageId: undefined, items: [], missingBackups: 0, outside: 0 });
	});

	test('arquivos marcados como revisados somem, e voltam se mudarem depois', async () => {
		const { items } = await review.computeReview({ file: sessionFile, id: sessionId }, [project]);
		const target = items.find(i => i.status === 'modified');
		const reviewed = { [target.file]: await review.fingerprint(target.file) };

		let split = await review.splitReviewed(items, reviewed);
		assert.equal(split.hidden, 1);
		assert.equal(split.pending.length, 2);

		fs.appendFileSync(target.file, 'mais uma linha\n');
		split = await review.splitReviewed(items, reviewed);
		assert.equal(split.hidden, 0, 'arquivo alterado depois de revisado volta para a lista');
	});
});
