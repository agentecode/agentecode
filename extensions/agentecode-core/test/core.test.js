/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../lib/i18n');
const { sessionToMarkdown, projectSlug, slugify } = require('../lib/sessionMarkdown');

// os textos esperados abaixo sao os em portugues, vindos do dicionario
i18n.setLanguage('pt');

test('projectSlug e slugify', () => {
	assert.equal(projectSlug('c:/WorkStation/AgenteCode'), 'c--WorkStation-AgenteCode');
	assert.equal(slugify('Correção: Logos flat!'), 'correcao-logos-flat');
});

test('sessionToMarkdown converte conversa, ferramentas e protege blocos de código', () => {
	const entries = [
		{ type: 'user', timestamp: '2026-10-18T21:00:00Z', cwd: 'C:/p', gitBranch: 'main', message: { role: 'user', content: 'Oi, liste os arquivos' } },
		{ type: 'assistant', timestamp: '2026-10-18T21:00:05Z', message: { model: 'claude-sonnet-5-5', content: [{ type: 'thinking', thinking: 'segredo interno' }] } },
		{ type: 'assistant', timestamp: '2026-10-18T21:00:06Z', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } },
		{ type: 'user', timestamp: '2026-10-18T21:00:07Z', message: { content: [{ type: 'tool_result', content: 'a.txt\n```\nb.txt' }] } },
		{ type: 'assistant', timestamp: '2026-10-18T21:00:08Z', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Pronto.' }] } },
		{ type: 'user', isMeta: true, message: { content: 'ignorar' } },
		{ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagente' }] } },
	];
	const md = sessionToMarkdown(entries, { title: 'Teste', sessionId: 'abc' });
	assert.match(md, /^# Teste/);
	assert.match(md, /\*\*Modelo:\*\* claude-sonnet-5-5/);
	assert.match(md, /## Usuário/);
	assert.match(md, /> \*\*Bash\*\* — `ls -la`/);
	assert.match(md, /````\na\.txt/, 'cerca maior que as crases do conteúdo');
	assert.match(md, /Pronto\./);
	assert.doesNotMatch(md, /segredo interno|ignorar|subagente/);

	const without = sessionToMarkdown(entries, { includeToolResults: false });
	assert.doesNotMatch(without, /a\.txt/);

	i18n.setLanguage('en');
	try {
		const english = sessionToMarkdown(entries, { title: 'Test', sessionId: 'abc' });
		assert.match(english, /\*\*Model:\*\* claude-sonnet-5-5/);
		assert.match(english, /## User/);
	} finally {
		i18n.setLanguage('pt');
	}
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectSnapshots, listCheckpoints, planRewind, isInsideAny } = require('../lib/checkpoints');
const { sessionMatches, entryText } = require('../lib/sessionStore');

/** Sessao sintetica: u1 cria a.txt; u2 edita a.txt e b.txt; u3 edita os dois de novo. */
function syntheticSession() {
	return [
		{ type: 'file-history-snapshot', messageId: 'u1', snapshot: { messageId: 'u1', trackedFileBackups: {}, timestamp: 't1' } },
		{ type: 'user', uuid: 'u1', timestamp: 't1', message: { content: 'crie o a.txt' } },
		{ type: 'file-history-delta', messageId: 'x', snapshotMessageId: 'u1', trackingPath: 'C:/p/a.txt', backup: { backupFileName: null, version: 1 }, timestamp: 't1' },
		{ type: 'file-history-snapshot', messageId: 'u2', snapshot: { messageId: 'u2', trackedFileBackups: { 'C:/p/a.txt': { backupFileName: 'aaaa@v2' } }, timestamp: 't2' } },
		{ type: 'user', uuid: 'u2', timestamp: 't2', message: { content: [{ type: 'text', text: 'edite a e b' }] } },
		{ type: 'user', uuid: 'tr', timestamp: 't2', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
		{ type: 'file-history-delta', messageId: 'x', snapshotMessageId: 'u2', trackingPath: 'C:/p/b.txt', backup: { backupFileName: 'bbbb@v1', version: 1 }, timestamp: 't2' },
		{ type: 'file-history-delta', messageId: 'x', snapshotMessageId: 'u2', trackingPath: 'C:/p/evil.txt', backup: { backupFileName: '../../segredo', version: 1 }, timestamp: 't2' },
		{ type: 'file-history-snapshot', messageId: 'u3', snapshot: { messageId: 'u3', trackedFileBackups: { 'C:/p/a.txt': { backupFileName: 'aaaa@v3' }, 'C:/p/b.txt': { backupFileName: 'bbbb@v2' } }, timestamp: 't3' } },
		{ type: 'user', uuid: 'u3', timestamp: 't3', message: { content: 'edite de novo' } },
	];
}

test('planRewind volta cada arquivo ao estado do inicio do turno', () => {
	const entries = syntheticSession();
	const asMap = plan => Object.fromEntries(plan.map(p => [path.basename(p.file), p.backupFileName]));

	assert.deepEqual(asMap(planRewind(entries, 'u1')), { 'a.txt': null, 'b.txt': 'bbbb@v1' }, 'a.txt nao existia antes do u1');
	assert.deepEqual(asMap(planRewind(entries, 'u2')), { 'a.txt': 'aaaa@v2', 'b.txt': 'bbbb@v1' });
	assert.deepEqual(asMap(planRewind(entries, 'u3')), { 'a.txt': 'aaaa@v3', 'b.txt': 'bbbb@v2' });
	assert.equal(planRewind(entries, 'inexistente'), undefined);
});

test('planRewind ignora nome de backup suspeito (caminho fora da pasta de historico)', () => {
	const plan = planRewind(syntheticSession(), 'u2');
	assert.ok(!plan.some(p => /evil/.test(p.file)));
});

test('listCheckpoints lista so prompts reais, do mais novo para o mais antigo', () => {
	const result = listCheckpoints(syntheticSession());
	assert.deepEqual(result.map(c => [c.messageId, c.prompt]), [['u3', 'edite de novo'], ['u2', 'edite a e b'], ['u1', 'crie o a.txt']]);
	assert.equal(collectSnapshots(syntheticSession()).length, 3);
});

test('isInsideAny respeita a pasta do projeto', () => {
	const root = path.join(os.tmpdir(), 'proj');
	assert.equal(isInsideAny(path.join(root, 'src', 'a.ts'), [root]), true);
	assert.equal(isInsideAny(path.join(root + '-outro', 'a.ts'), [root]), false);
	assert.equal(isInsideAny(path.join(os.tmpdir(), 'fora.ts'), [root]), false);
	assert.equal(isInsideAny(path.join(root, 'a.ts'), [path.join(root, 'a.ts')]), true, 'mesmo arquivo conta como dentro');
});

test('sessionMatches encontra texto de mensagens e ignora o resto', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sessao-'));
	const file = path.join(dir, 's.jsonl');
	const lines = [
		{ type: 'user', message: { content: 'Ajuste o Tema Deep Teal' } },
		{ type: 'assistant', message: { content: [{ type: 'text', text: 'feito' }, { type: 'tool_use', name: 'Bash', input: { command: 'palavra-so-na-ferramenta' } }] } },
	].map(o => JSON.stringify(o));
	fs.writeFileSync(file, lines.join('\n') + '\n{linha truncada\n');
	try {
		assert.equal(await sessionMatches(file, 'deep teal'), true, 'sem diferenciar maiusculas');
		assert.equal(await sessionMatches(file, 'feito'), true);
		assert.equal(await sessionMatches(file, 'palavra-so-na-ferramenta'), false, 'busca so em texto de mensagens');
		assert.equal(await sessionMatches(file, 'inexistente'), false);
		assert.equal(entryText({ message: { content: 'x' } }), 'x');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('sessao real: todo checkpoint aponta para copias que existem em disco', { skip: !fs.existsSync(path.join(os.homedir(), '.claude', 'file-history', 'ed19cac5-ef2d-4012-a5da-c8bfc282ffa2')) }, async () => {
	const { readEntries } = require('../lib/sessionMarkdown');
	const id = 'ed19cac5-ef2d-4012-a5da-c8bfc282ffa2';
	const file = path.join(os.homedir(), '.claude', 'projects', 'c--WorkStation-AgenteCode', `${id}.jsonl`);
	if (!fs.existsSync(file)) {
		return;
	}
	const entries = [];
	await readEntries(file, e => entries.push(e.type === 'user' ? { type: 'user', uuid: e.uuid, isMeta: e.isMeta, isSidechain: e.isSidechain, timestamp: e.timestamp, message: { content: typeof e.message?.content === 'string' ? e.message.content : (Array.isArray(e.message?.content) && !e.message.content.some(b => b.type === 'tool_result') ? e.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '') } } : e), l => l.includes('"type":"user"') || l.includes('"type":"file-history-'));
	const checkpoints = listCheckpoints(entries);
	assert.ok(checkpoints.length > 20, `esperava varios checkpoints, veio ${checkpoints.length}`);
	const dir = path.join(os.homedir(), '.claude', 'file-history', id);
	let withFiles = 0;
	for (const checkpoint of checkpoints) {
		const plan = planRewind(entries, checkpoint.messageId);
		if (plan.length) {
			withFiles++;
		}
		for (const item of plan.filter(p => p.backupFileName)) {
			assert.ok(fs.existsSync(path.join(dir, item.backupFileName)), `copia ausente: ${item.backupFileName}`);
		}
	}
	assert.ok(withFiles > 0);
});

test('volta de arquivos no disco: restaura editado, exclui criado pelo agente e recria apagado', async () => {
	const { diffPlanAgainstDisk, applyChange } = require('../lib/rewindPlan');
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rewind-'));
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
	const sessionId = 'sess-1';
	const history = path.join(base, 'claude', 'file-history', sessionId);
	const project = path.join(base, 'proj');
	fs.mkdirSync(history, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	try {
		const edited = path.join(project, 'edited.txt');
		const created = path.join(project, 'created.txt');
		const deleted = path.join(project, 'deleted.txt');
		const untouched = path.join(project, 'untouched.txt');

		// estado de ANTES do turno, guardado como copias do historico
		fs.writeFileSync(path.join(history, 'aaaa@v1'), 'edited original');
		fs.writeFileSync(path.join(history, 'bbbb@v1'), 'deleted original');
		fs.writeFileSync(path.join(history, 'cccc@v1'), 'untouched');
		// estado de DEPOIS (o que o agente deixou)
		fs.writeFileSync(edited, 'edited pelo agente');
		fs.writeFileSync(created, 'criado pelo agente');
		fs.writeFileSync(untouched, 'untouched');

		const entries = [
			{ type: 'file-history-snapshot', messageId: 'm1', snapshot: { messageId: 'm1', trackedFileBackups: { [edited]: { backupFileName: 'aaaa@v1' }, [deleted]: { backupFileName: 'bbbb@v1' }, [untouched]: { backupFileName: 'cccc@v1' } }, timestamp: 't' } },
			{ type: 'file-history-delta', snapshotMessageId: 'm1', trackingPath: created, backup: { backupFileName: null, version: 1 }, timestamp: 't' },
			{ type: 'user', uuid: 'm1', message: { content: 'faca tudo' } },
		];
		const plan = planRewind(entries, 'm1');
		const { changes, missingBackups } = await diffPlanAgainstDisk(plan, sessionId);

		assert.equal(missingBackups, 0);
		assert.deepEqual(
			changes.map(c => [path.basename(c.file), c.action]).sort(),
			[['created.txt', 'delete'], ['deleted.txt', 'recreate'], ['edited.txt', 'restore']],
			'arquivo sem mudanca nao entra no plano'
		);

		for (const change of changes) {
			await applyChange(change);
		}
		assert.equal(fs.readFileSync(edited, 'utf8'), 'edited original');
		assert.equal(fs.readFileSync(deleted, 'utf8'), 'deleted original');
		assert.equal(fs.existsSync(created), false);
		assert.equal(fs.readFileSync(untouched, 'utf8'), 'untouched');

		assert.deepEqual((await diffPlanAgainstDisk(plan, sessionId)).changes, [], 'depois de voltar, nao sobra nada a fazer');
	} finally {
		if (previous === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = previous;
		}
		fs.rmSync(base, { recursive: true, force: true });
	}
});

const { parseVersion, notesBetween, sectionFor, parseSections } = require('../lib/releaseNotes');

const NOTES = [
	'# Novidades',
	'',
	'texto solto antes das secoes',
	'',
	'## v1.2.0 - 03/12/2026',
	'- nova 1.2',
	'',
	'## v1.1.0 - 02/11/2026',
	'### Algo',
	'- nova 1.1',
	'',
	'## v1.0.0 - 20/10/2026',
	'- nova 1.0',
	'',
	'## Sem versao no titulo',
	'- ignorar',
].join('\n');

test('notas: parseVersion e secoes', () => {
	assert.deepEqual(parseVersion('v0.0.6-test'), [0, 0, 6]);
	assert.deepEqual(parseSections(NOTES).map(s => s.version.join('.')), ['1.2.0', '1.1.0', '1.0.0']);
	assert.ok(!parseSections(NOTES).some(s => s.text.includes('ignorar')), 'titulo sem versao encerra a secao anterior e e descartado');
});

test('notas: mostra so o que passou entre a versao vista e a atual', () => {
	assert.match(notesBetween(NOTES, '1.0.0', '1.1.0'), /^## v1\.1\.0/);
	assert.doesNotMatch(notesBetween(NOTES, '1.0.0', '1.1.0'), /nova 1\.0|nova 1\.2/);

	const skipped = notesBetween(NOTES, '1.0.0', '1.2.0');
	assert.ok(skipped.indexOf('v1.2.0') < skipped.indexOf('v1.1.0'), 'mais nova primeiro');
	assert.doesNotMatch(skipped, /nova 1\.0/);

	assert.equal(notesBetween(NOTES, '1.2.0', '1.2.0'), '', 'mesma versao: nada');
	assert.equal(notesBetween(NOTES, '1.2.0', '1.0.0'), '', 'rebaixar: nada');
	assert.match(notesBetween(NOTES, undefined, '1.1.0'), /nova 1\.1/, 'sem versao vista: so a atual e anteriores ate ela');
	assert.equal(notesBetween(NOTES, '1.0.0', 'sem versao'), '');
});

test('notas: sectionFor aceita tags de pre-lancamento', () => {
	assert.match(sectionFor(NOTES, 'v1.1.0-rc.1'), /nova 1\.1/);
	assert.equal(sectionFor(NOTES, 'v9.9.9'), '');
});

test('notas: o RELEASE_NOTES.md real tem a secao da versao do produto', () => {
	const real = fs.readFileSync(path.join(__dirname, '..', 'RELEASE_NOTES.md'), 'utf8');
	const productJson = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'product.json'), 'utf8');
	const version = parseVersion(/"nameLong":\s*"([^"]+)"/.exec(productJson)[1]).join('.');
	assert.ok(sectionFor(real, version).length > 100, `faltam notas para a versao ${version}`);
});
