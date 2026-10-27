/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { resolveLanguage, setLanguage, getLanguage, t } = require('../lib/i18n');

describe('Traducao', () => {
	afterEach(() => setLanguage('en'));

	test('sem traducao o texto em ingles e devolvido, com os argumentos no lugar', () => {
		assert.equal(t('Hello {0}, you have {1} items', 'Ana', 3), 'Hello Ana, you have 3 items');
		assert.equal(t('Not translated'), 'Not translated');
	});

	test('o idioma e escolhido pela configuracao ou pelo idioma de exibicao do VS Code', () => {
		assert.deepEqual(
			[
				resolveLanguage('en', 'pt-br'),
				resolveLanguage('pt-BR', 'en'),
				resolveLanguage('auto', 'pt-br'),
				resolveLanguage('auto', 'en'),
				resolveLanguage('auto', 'es'),
				resolveLanguage(undefined, undefined),
			],
			['en', 'pt', 'pt', 'en', 'en', 'en']
		);
	});

	test('setLanguage troca o idioma usado por t', () => {
		setLanguage('pt');
		assert.equal(getLanguage(), 'pt');
		setLanguage('en');
		assert.equal(getLanguage(), 'en');
	});
});
