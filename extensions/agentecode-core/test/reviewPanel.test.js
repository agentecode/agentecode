/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { languageBadge } = require('../lib/reviewPanelLib');
const { renderPanelHtml, CLIENT_SCRIPT } = require('../lib/reviewPanelHtml');
const { setLanguage } = require('../lib/i18n');

describe('Tela Alteracoes do agente (webview)', () => {
	before(() => setLanguage('pt'));
	after(() => setLanguage('en'));

	test('selo de linguagem por extensao e por nome especial', () => {
		assert.equal(languageBadge('C:\\p\\lib\\a.js').text, 'JS');
		assert.equal(languageBadge('/p/a.YML').text, 'YML');
		assert.equal(languageBadge('/p/Makefile').text, 'MAK');
		assert.equal(languageBadge('/p/.gitignore').text, 'GIT');
		assert.equal(languageBadge('/p/x.abcdef').text, 'ABC');
		assert.equal(languageBadge('/p/semextensao').text, '?');
	});

	test('a pagina tem CSP com nonce, so scripts com o nonce e o script do navegador e JavaScript valido', () => {
		const html = renderPanelHtml({ nonce: 'xyz', cspSource: 'vscode-webview:' });
		assert.ok(html.includes('script-src \'nonce-xyz\''));
		assert.ok(html.includes('<script nonce="xyz">'));
		assert.ok(!html.includes('default-src *'));
		assert.doesNotThrow(() => new Function('acquireVsCodeApi', 'document', 'window', CLIENT_SCRIPT));
	});

	test('os textos do navegador saem traduzidos (pt) e em ingles (en)', () => {
		const pt = renderPanelHtml({ nonce: 'xyz', cspSource: 'c' });
		assert.ok(pt.includes('Aceitar tudo') && pt.includes('lang="pt-BR"'));
		setLanguage('en');
		const en = renderPanelHtml({ nonce: 'xyz', cspSource: 'c' });
		assert.ok(en.includes('Accept all') && !en.includes('Aceitar tudo') && en.includes('lang="en"'));
		setLanguage('pt');
	});

	test('o script nunca insere texto como HTML', () => {
		assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(CLIENT_SCRIPT));
	});

	test('o clique direito nas linhas diz de qual arquivo se trata e o package.json liga o menu a essa mesma secao', () => {
		const section = 'agentecodeReviewRow';
		assert.ok(CLIENT_SCRIPT.includes('data-vscode-context') && CLIENT_SCRIPT.includes(section));
		assert.ok(!CLIENT_SCRIPT.includes('preventDefaultContextMenuItems'), 'o menu padrao (Cut, Copy, Paste) continua junto dos itens novos');
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
		const menu = manifest.contributes.menus['webview/context'];
		assert.deepEqual(menu.map(entry => entry.command), ['agentecode.review.openFileFromPanel', 'agentecode.review.openFromPanel']);
		assert.ok(menu.every(entry => entry.when === `webviewSection == '${section}'`));
		const titles = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf8'));
		for (const command of ['agentecode.review.openFile', 'agentecode.review.openFileFromPanel', 'agentecode.review.openFromPanel']) {
			assert.ok(manifest.contributes.commands.some(entry => entry.command === command), command);
		}
		assert.equal(titles['command.review.openFileFromPanel.title'], 'Open File in Editor (Ctrl+Click)');
		assert.equal(titles['command.review.openFromPanel.title'], 'View Diff (Click)');
		assert.ok(/ctrlKey[^;]*openFile/.test(CLIENT_SCRIPT), 'Ctrl+clique no nome abre o arquivo');
	});
});
