/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { languageBadge } = require('../lib/reviewPanelLib');
const { renderPanelHtml, CLIENT_SCRIPT } = require('../lib/reviewPanelHtml');

describe('Tela Alteracoes do agente (webview)', () => {
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

	test('o script nunca insere texto como HTML', () => {
		assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(CLIENT_SCRIPT));
	});
});
