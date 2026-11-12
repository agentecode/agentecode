/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { setComment, addRejected, buildPrompt, MAX_REJECTED } = require('../lib/reviewComments');

test('setComment adds, replaces and removes by file and hunk', () => {
	let list = setComment([], { file: 'a.cs', key: 'k1', line: 3, text: ' fix this ', snippet: ['x'] });
	assert.deepStrictEqual(list.map(c => c.text), ['fix this']);
	list = setComment(list, { file: 'a.cs', key: 'k1', line: 3, text: 'changed', snippet: [] });
	assert.strictEqual(list.length, 1);
	assert.strictEqual(list[0].text, 'changed');
	list = setComment(list, { file: 'a.cs', key: 'k2', line: 9, text: 'other', snippet: [] });
	assert.strictEqual(list.length, 2);
	list = setComment(list, { file: 'a.cs', key: 'k1', line: 3, text: '   ', snippet: [] });
	assert.deepStrictEqual(list.map(c => c.key), ['k2']);
});

test('addRejected does not repeat and keeps only the latest', () => {
	let list = addRejected([], { file: 'a.cs', line: 5 });
	list = addRejected(list, { file: 'a.cs', line: 5 });
	assert.strictEqual(list.length, 1);
	for (let i = 0; i < MAX_REJECTED + 10; i++) {
		list = addRejected(list, { file: 'f' + i + '.cs' });
	}
	assert.strictEqual(list.length, MAX_REJECTED);
	assert.strictEqual(list[list.length - 1].file, 'f' + (MAX_REJECTED + 9) + '.cs');
});

test('buildPrompt lists comments with code and the discarded changes', () => {
	const text = buildPrompt(
		[{ file: 'src/a.cs', key: 'k', line: 42, text: 'handle null', snippet: ['var x = y;'] }],
		[{ file: 'src/b.cs', line: 7, snippet: ['  foo();'] }, { file: 'src/c.cs' }]
	);
	assert.match(text, /1\. src\/a\.cs:42/);
	assert.match(text, /Comment: handle null/);
	assert.match(text, /var x = y;/);
	assert.match(text, /- src\/b\.cs:7 \(the lines starting with: foo\(\);\)/);
	assert.match(text, /- src\/c\.cs \(the whole file was reverted\)/);
	assert.ok(!/Changes I discarded/.test(buildPrompt([{ file: 'a', key: 'k', line: 1, text: 't', snippet: [] }], [])));
});
