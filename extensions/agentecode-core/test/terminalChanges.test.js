/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gs = require('../lib/gitSnapshot');
const { computeTerminalChanges } = require('../lib/terminalChanges');

let hasGit = true;
try {
	execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
	hasGit = false;
}
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('Mudancas feitas por terminal', { skip: !hasGit }, () => {
	let repo;
	let beforeDir;

	before(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-term-'));
		beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-term-before-'));
		run(repo, 'init', '-q');
		run(repo, 'config', 'user.email', 'teste@example.com');
		run(repo, 'config', 'user.name', 'Teste');
		run(repo, 'config', 'core.autocrlf', 'false');
		fs.mkdirSync(path.join(repo, 'src'));
		fs.writeFileSync(path.join(repo, 'src', 'Colaborador.cs'), 'class Colaborador {\n\tint Id;\n}\n');
		fs.writeFileSync(path.join(repo, 'velho.txt'), 'apagar\n');
		run(repo, 'add', '-A');
		run(repo, 'commit', '-q', '-m', 'inicio');
	});

	after(() => {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(beforeDir, { recursive: true, force: true });
	});

	test('modo exato: pega o que perl, sed ou cat > mudaram desde a foto, com o antes guardado', async () => {
		const baseTree = await gs.snapshotTree(repo);

		// como o agente fez no ERP: troca no lugar, arquivo novo por redirecionamento, remocao
		fs.writeFileSync(path.join(repo, 'src', 'Colaborador.cs'), 'class Colaborador {\n\tint Id;\n\tstring Nome;\n}\n');
		fs.writeFileSync(path.join(repo, 'src', 'ColaboradorMapper.cs'), 'class ColaboradorMapper { }\n');
		fs.rmSync(path.join(repo, 'velho.txt'));

		const result = await computeTerminalChanges({ repoRoot: repo, baseTree, beforeDir });
		assert.equal(result.mode, 'exact');
		assert.deepEqual(
			result.items.map(i => [path.relative(repo, i.file).replace(/\\/g, '/'), i.status, i.added, i.removed, i.approx]),
			[
				['src/Colaborador.cs', 'modified', 1, 0, false],
				['src/ColaboradorMapper.cs', 'added', 1, 0, false],
				['velho.txt', 'deleted', 0, 1, false]
			]
		);
		const modified = result.items.find(i => i.status === 'modified');
		assert.equal(fs.readFileSync(modified.backup, 'utf8'), 'class Colaborador {\n\tint Id;\n}\n');
		assert.equal(result.items.find(i => i.status === 'added').backup, undefined);
		assert.equal(fs.readFileSync(result.items.find(i => i.status === 'deleted').backup, 'utf8'), 'apagar\n');
	});

	test('modo aproximado (sem foto): usa o ultimo commit e a janela de horario da conversa', async () => {
		const now = Date.now();
		const inWindow = await computeTerminalChanges({ repoRoot: repo, beforeDir, window: { from: now - 60_000, to: now + 60_000 } });
		assert.equal(inWindow.mode, 'approx');
		assert.ok(inWindow.items.length >= 2);
		assert.ok(inWindow.items.every(i => i.approx));

		// conversa de ontem: os arquivos mexidos agora ficam de fora (os apagados nao tem horario e continuam)
		const yesterday = now - 24 * 3600 * 1000;
		const outside = await computeTerminalChanges({ repoRoot: repo, beforeDir, window: { from: yesterday - 60_000, to: yesterday } });
		assert.deepEqual(outside.items.map(i => i.status), ['deleted']);
	});

	test('modo aproximado enxerga o que foi commitado no meio da conversa', async () => {
		const day = 24 * 3600 * 1000;
		const dated = ms => ({ ...process.env, GIT_COMMITTER_DATE: new Date(ms).toISOString(), GIT_AUTHOR_DATE: new Date(ms).toISOString() });
		const mid = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mid-'));
		const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mid-before-'));
		try {
			run(mid, 'init', '-q');
			run(mid, 'config', 'user.email', 'teste@example.com');
			run(mid, 'config', 'user.name', 'Teste');
			run(mid, 'config', 'core.autocrlf', 'false');
			fs.writeFileSync(path.join(mid, 'antes.txt'), 'original\n');
			fs.writeFileSync(path.join(mid, 'commitado.txt'), 'original\n');
			fs.writeFileSync(path.join(mid, 'solto.txt'), 'original\n');
			run(mid, 'add', '-A');
			execFileSync('git', ['commit', '-q', '-m', 'antes da conversa'], { cwd: mid, env: dated(Date.now() - 2 * day) });

			// a "conversa" comeca agora: o agente mexe em dois arquivos e o usuario commita um deles no meio
			const from = Date.now() - 60_000;
			fs.writeFileSync(path.join(mid, 'commitado.txt'), 'original\nmudou\n');
			run(mid, 'add', 'commitado.txt');
			execFileSync('git', ['commit', '-q', '-m', 'commit no meio da conversa'], { cwd: mid });
			fs.writeFileSync(path.join(mid, 'solto.txt'), 'original\nmudou tambem\n');
			fs.writeFileSync(path.join(mid, 'novo.txt'), 'novo\n');

			const result = await computeTerminalChanges({ repoRoot: mid, beforeDir: store, window: { from, to: Date.now() } });
			assert.equal(result.mode, 'approx');
			assert.deepEqual(
				result.items.map(i => [path.basename(i.file), i.status]),
				[['commitado.txt', 'modified'], ['novo.txt', 'added'], ['solto.txt', 'modified']],
				'o arquivo commitado no meio da conversa nao pode sumir'
			);
			assert.equal(fs.readFileSync(result.items[0].backup, 'utf8'), 'original\n');
		} finally {
			fs.rmSync(mid, { recursive: true, force: true });
			fs.rmSync(store, { recursive: true, force: true });
		}
	});

	test('foto que o git ja limpou cai no modo aproximado', async () => {
		const result = await computeTerminalChanges({ repoRoot: repo, baseTree: '0000000000000000000000000000000000000001', beforeDir });
		assert.equal(result.mode, 'approx');
	});
});
