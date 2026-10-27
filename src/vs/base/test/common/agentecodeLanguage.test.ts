/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { agenteCodeText, resolveAgenteCodeLanguage } from '../../common/agentecodeLanguage.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('agentecodeLanguage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolveAgenteCodeLanguage', () => {
		assert.deepStrictEqual(
			[
				resolveAgenteCodeLanguage('en', 'pt-BR'),
				resolveAgenteCodeLanguage('pt-BR', 'en-US'),
				resolveAgenteCodeLanguage('pt', 'en-US'),
				resolveAgenteCodeLanguage('auto', 'pt-BR'),
				resolveAgenteCodeLanguage('auto', 'en-US'),
				resolveAgenteCodeLanguage(undefined, 'pt-PT'),
				resolveAgenteCodeLanguage('', 'de-DE'),
				resolveAgenteCodeLanguage('auto', undefined),
			],
			['en', 'pt', 'pt', 'pt', 'en', 'pt', 'en', 'en']
		);
	});

	test('agenteCodeText', () => {
		const texts = { en: 'Saved', pt: 'Salvo' };
		assert.deepStrictEqual([agenteCodeText('en', texts), agenteCodeText('pt', texts)], ['Saved', 'Salvo']);
	});
});
