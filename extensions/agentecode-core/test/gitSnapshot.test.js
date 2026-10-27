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

let hasGit = true;
try {
	execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
	hasGit = false;
}

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('Fotos do projeto com o git', { skip: !hasGit }, () => {
	let repo;

	before(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-gitsnap-'));
		run(repo, 'init', '-q');
		run(repo, 'config', 'user.email', 'teste@example.com');
		run(repo, 'config', 'user.name', 'Teste');
		run(repo, 'config', 'core.autocrlf', 'false');
		fs.writeFileSync(path.join(repo, '.gitignore'), 'ignorado.txt\n');
		fs.writeFileSync(path.join(repo, 'a.txt'), 'um\ndois\ntres\n');
		fs.writeFileSync(path.join(repo, 'b.txt'), 'sera apagado\n');
		run(repo, 'add', '-A');
		run(repo, 'commit', '-q', '-m', 'inicio');
	});

	after(() => {
		fs.rmSync(repo, { recursive: true, force: true });
	});

	test('repoRoot acha a raiz e devolve null fora de um repositorio', async () => {
		const sub = path.join(repo, 'sub');
		fs.mkdirSync(sub, { recursive: true });
		assert.equal((await gs.repoRoot(sub)).toLowerCase(), path.normalize(repo).toLowerCase());
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-nogit-'));
		try {
			assert.equal(await gs.repoRoot(outside), null);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('compara duas fotos e pega mudancas feitas por fora de qualquer ferramenta de edicao', async () => {
		const before = await gs.snapshotTree(repo);

		// o que um perl -pi, um sed -i, um script ou um cat > fariam
		fs.writeFileSync(path.join(repo, 'a.txt'), 'um\nDOIS\ntres\nquatro\n');
		fs.writeFileSync(path.join(repo, 'novo.txt'), 'arquivo novo\n');
		fs.rmSync(path.join(repo, 'b.txt'));
		fs.writeFileSync(path.join(repo, 'ignorado.txt'), 'nao entra\n');

		const now = await gs.snapshotTree(repo);
		const changes = await gs.diffTrees(repo, before, now);
		assert.deepEqual(changes.map(c => [c.path, c.status, c.added, c.removed]), [
			['a.txt', 'M', 2, 1],
			['b.txt', 'D', 0, 1],
			['novo.txt', 'A', 1, 0]
		]);

		assert.equal((await gs.blobAt(repo, before, 'a.txt')).toString('utf8'), 'um\ndois\ntres\n');
		assert.equal(await gs.blobAt(repo, before, 'novo.txt'), null);
		assert.ok(await gs.hasObject(repo, before));
		assert.equal(await gs.hasObject(repo, '0000000000000000000000000000000000000001'), false);
	});

	test('tirar a foto nao mexe no indice nem no historico do usuario', async () => {
		const stagedBefore = run(repo, 'diff', '--cached', '--name-only');
		const logBefore = run(repo, 'log', '--oneline');
		await gs.snapshotTree(repo);
		assert.equal(run(repo, 'diff', '--cached', '--name-only'), stagedBefore);
		assert.equal(run(repo, 'log', '--oneline'), logBefore);
		assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'um\nDOIS\ntres\nquatro\n');
	});

	test('changesVsHead lista o que mudou em relacao ao ultimo commit, sem escrever nada', async () => {
		const changes = await gs.changesVsHead(repo);
		assert.deepEqual(changes.map(c => [c.path, c.status]), [['a.txt', 'M'], ['b.txt', 'D'], ['novo.txt', 'A']]);
		const a = changes.find(c => c.path === 'a.txt');
		assert.deepEqual([a.added, a.removed], [2, 1]);
	});
});
