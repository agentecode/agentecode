/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

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
});
