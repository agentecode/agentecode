/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookCommand, hasStopHook, withStopHook, withoutStopHook, installHook, removeHook, HOOK_SCRIPT } = require('../lib/doneHook');

const CMD = hookCommand('/home/u');

test('withStopHook acrescenta o hook sem tocar nos outros e sem duplicar', () => {
	const other = { hooks: [{ type: 'command', command: 'echo outro' }] };
	const base = { theme: 'dark', hooks: { Stop: [other], PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
	const once = withStopHook(base, CMD);
	assert.equal(hasStopHook(once), true);
	assert.equal(once.theme, 'dark');
	assert.deepEqual(once.hooks.Stop[0], other);
	assert.equal(once.hooks.Stop.length, 2);
	assert.equal(withStopHook(once, CMD).hooks.Stop.length, 2);
	assert.equal(hasStopHook(base), false, 'o original nao e alterado');
});

test('withoutStopHook remove so o nosso e limpa o que ficar vazio', () => {
	const other = { hooks: [{ type: 'command', command: 'echo outro' }] };
	const both = withStopHook({ hooks: { Stop: [other] } }, CMD);
	assert.deepEqual(withoutStopHook(both).hooks.Stop, [other]);
	assert.deepEqual(withoutStopHook(withStopHook({}, CMD)), {});
	assert.deepEqual(withoutStopHook({ a: 1 }), { a: 1 });
});

test('installHook e removeHook gravam o script, ajustam o settings e guardam copia do original', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-hook-'));
	try {
		const settingsFile = path.join(home, '.claude', 'settings.json');
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify({ cleanupPeriodDays: 14 }));
		const first = installHook({ home, settingsFile });
		assert.equal(first.alreadyInstalled, false);
		assert.ok(fs.existsSync(path.join(home, '.agentecode', 'claude-done.js')));
		assert.equal(JSON.parse(fs.readFileSync(`${settingsFile}.agentecode-backup`, 'utf8')).cleanupPeriodDays, 14);
		const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		assert.equal(saved.cleanupPeriodDays, 14);
		assert.equal(hasStopHook(saved), true);
		assert.equal(installHook({ home, settingsFile }).alreadyInstalled, true);
		assert.equal(removeHook({ home, settingsFile }).wasInstalled, true);
		assert.equal(hasStopHook(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))), false);
		assert.equal(fs.existsSync(path.join(home, '.agentecode', 'claude-done.js')), false);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test('um settings.json ilegivel nao e sobrescrito', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-hook-'));
	try {
		const settingsFile = path.join(home, 'settings.json');
		fs.writeFileSync(settingsFile, '{ nao e json');
		assert.throws(() => installHook({ home, settingsFile }));
		assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ nao e json');
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test('o script do hook grava horario, pasta e sessao recebidos do Claude Code', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-hook-'));
	try {
		const script = path.join(home, 'hook.js');
		fs.writeFileSync(script, HOOK_SCRIPT);
		const run = spawnSync(process.execPath, [script], {
			input: JSON.stringify({ cwd: 'C:\\proj', session_id: 'abc' }),
			env: { ...process.env, HOME: home, USERPROFILE: home }
		});
		assert.equal(run.status, 0);
		const signal = JSON.parse(fs.readFileSync(path.join(home, '.agentecode', 'claude-done.json'), 'utf8'));
		assert.equal(signal.cwd, 'C:\\proj');
		assert.equal(signal.session, 'abc');
		assert.ok(Math.abs(Date.now() - signal.t) < 10_000);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
