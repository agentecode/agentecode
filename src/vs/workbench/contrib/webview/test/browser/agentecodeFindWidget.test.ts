/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { setFindWidgetViewTypes, shouldEnableFindWidget } from '../../browser/agentecodeFindWidget.js';

suite('AgenteCode find widget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => setFindWidgetViewTypes(undefined));

	test('only the configured view types get the find widget', () => {
		assert.deepStrictEqual(
			[
				shouldEnableFindWidget('markhub.previewStandalone'),
				shouldEnableFindWidget('mainThreadWebview-markhub.previewStandalone'),
				shouldEnableFindWidget('MarkHub.editor'),
				shouldEnableFindWidget('claudeVSCodePanel'),
				shouldEnableFindWidget(undefined),
			],
			[true, true, true, false, false]
		);
	});

	test('the list can be changed and invalid values fall back to the default', () => {
		setFindWidgetViewTypes(['claude', '', 3]);
		assert.deepStrictEqual([shouldEnableFindWidget('claudeVSCodePanel'), shouldEnableFindWidget('markhub.x')], [true, false]);
		setFindWidgetViewTypes('not a list');
		assert.deepStrictEqual([shouldEnableFindWidget('claudeVSCodePanel'), shouldEnableFindWidget('markhub.x')], [false, true]);
	});
});
