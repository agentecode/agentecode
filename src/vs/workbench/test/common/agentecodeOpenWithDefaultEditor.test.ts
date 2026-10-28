/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { shouldOpenWithDefaultEditor } from '../../common/agentecodeOpenWithDefaultEditor.js';

suite('AgenteCode open with default editor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Markdown files match by default and other files do not', () => {
		assert.deepStrictEqual(
			[
				shouldOpenWithDefaultEditor(undefined, URI.file('c:\\docs\\G3_migration_v2.md')),
				shouldOpenWithDefaultEditor(undefined, URI.file('/home/user/readme.md')),
				shouldOpenWithDefaultEditor(undefined, URI.file('c:\\src\\Program.cs')),
			],
			[true, true, false]
		);
	});

	test('the list is configurable and invalid values fall back to the default', () => {
		assert.deepStrictEqual(
			[
				shouldOpenWithDefaultEditor(['**/*.md', '**/*.markdown'], URI.file('/a/b.markdown')),
				shouldOpenWithDefaultEditor([], URI.file('/a/b.md')),
				shouldOpenWithDefaultEditor('not a list', URI.file('/a/b.md')),
			],
			[true, false, true]
		);
	});
});
