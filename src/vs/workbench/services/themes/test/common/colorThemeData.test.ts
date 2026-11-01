/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Color } from '../../../../../base/common/color.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { editorBackground, foreground, inputBackground, inputForeground } from '../../../../../platform/theme/common/colorRegistry.js';
import { ColorThemeData, isEditorColor } from '../../common/colorThemeData.js';

suite('ColorThemeData - transient colors', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('updates programmatic colors, derived defaults and token caches', () => {
		const theme = ColorThemeData.createUnloadedTheme('vs-dark', { [foreground]: '#eeeeee', [editorBackground]: '#202020' });
		const beforeTokens = theme.tokenColors;
		theme.setTransientColors({ [foreground]: Color.fromHex('#ddccbb'), [editorBackground]: Color.fromHex('#28221e') });
		assert.deepStrictEqual({
			foreground: theme.getColor(foreground, false)?.toString(),
			derived: theme.getColor(inputForeground)?.toString(),
			defines: theme.defines(foreground),
			tokenBackground: theme.tokenColors[0].settings.background,
			tokensInvalidated: theme.tokenColors !== beforeTokens,
		}, {
			foreground: '#ddccbb',
			derived: '#ddccbb',
			defines: true,
			tokenBackground: '#28221E',
			tokensInvalidated: true,
		});
	});

	test('clearing runtime colors restores theme and user-customized colors', () => {
		const theme = ColorThemeData.createUnloadedTheme('vs-dark', { [editorBackground]: '#202020' });
		theme.setCustomColors({ [inputBackground]: '#123456' });
		theme.setTransientColors({ [inputBackground]: Color.fromHex('#654321'), [editorBackground]: Color.fromHex('#28221e') });
		theme.setTransientColors(undefined);
		assert.deepStrictEqual({
			editor: theme.getColor(editorBackground)?.toString(),
			input: theme.getColor(inputBackground)?.toString(),
			customization: theme.getColorCustomization(inputBackground)?.toString(),
		}, { editor: '#202020', input: '#123456', customization: '#123456' });
	});

	test('exposes untinted startup colors without changing the active theme', () => {
		const theme = ColorThemeData.createUnloadedTheme('vs-dark', { [editorBackground]: '#202020' });
		theme.setCustomColors({ [inputBackground]: '#123456' });
		theme.setTransientColors({ [inputBackground]: Color.fromHex('#654321'), [editorBackground]: Color.fromHex('#28221e') });
		const baseTheme = theme.getBaseTheme();
		assert.deepStrictEqual({
			active: theme.getColor(editorBackground)?.toString(),
			base: baseTheme.getColor(editorBackground)?.toString(),
			baseCustomization: baseTheme.getColor(inputBackground)?.toString(),
			activeTokenBackground: theme.tokenColors[0].settings.background,
			baseTokenBackground: baseTheme.tokenColors[0].settings.background,
		}, {
			active: '#28221e',
			base: '#202020',
			baseCustomization: '#123456',
			activeTokenBackground: '#28221E',
			baseTokenBackground: '#202020',
		});
	});

	test('does not persist generated colors or affect another theme instance', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		const theme = ColorThemeData.createUnloadedTheme('vs-dark', { [editorBackground]: '#202020' });
		theme.toStorage(storageService);
		const originalStorage = storageService.get(ColorThemeData.STORAGE_KEY, StorageScope.PROFILE);
		const otherWindowTheme = ColorThemeData.fromStorageData(storageService)!;
		theme.setTransientColors({ [editorBackground]: Color.fromHex('#28221e') });
		theme.toStorage(storageService);
		const restored = ColorThemeData.fromStorageData(storageService)!;
		assert.deepStrictEqual({
			active: theme.getColor(editorBackground)?.toString(),
			otherWindow: otherWindowTheme.getColor(editorBackground)?.toString(),
			restored: restored.getColor(editorBackground)?.toString(),
			unchangedStorage: storageService.get(ColorThemeData.STORAGE_KEY, StorageScope.PROFILE) === originalStorage,
		}, { active: '#28221e', otherWindow: '#202020', restored: '#202020', unchangedStorage: true });
	});
});

suite('ColorThemeData - separate editor theme', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createThemes() {
		const main = ColorThemeData.createUnloadedTheme('vs-dark', { [editorBackground]: '#202020', [inputBackground]: '#101010' });
		const editor = ColorThemeData.createUnloadedTheme('vs', { [editorBackground]: '#ffffff', [inputBackground]: '#eeeeee' });
		return { main, editor };
	}

	test('editor colors and syntax come from the editor theme, everything else from the main theme', () => {
		const { main, editor } = createThemes();
		editor.setCustomTokenColors({ textMateRules: [{ scope: 'keyword', settings: { foreground: '#ff0000' } }] });
		const hasKeywordRule = (theme: ColorThemeData) => theme.tokenColors.some(rule => rule.scope === 'keyword' && rule.settings.foreground === '#FF0000');
		const before = hasKeywordRule(main);
		main.setEditorTheme(editor);
		assert.deepStrictEqual({
			before,
			editorBackground: main.getColor(editorBackground)?.toString(),
			inputBackground: main.getColor(inputBackground)?.toString(),
			tokenBackground: main.tokenColors[0].settings.background,
			editorSyntax: hasKeywordRule(main),
			defines: main.defines(editorBackground),
		}, {
			before: false,
			editorBackground: '#ffffff',
			inputBackground: '#101010',
			tokenBackground: '#FFFFFF',
			editorSyntax: true,
			defines: true,
		});
	});

	test('customizations of the main theme still win, and clearing the editor theme restores it', () => {
		const { main, editor } = createThemes();
		main.setEditorTheme(editor);
		main.setCustomColors({ [editorBackground]: '#123456' });
		const customized = main.getColor(editorBackground)?.toString();
		main.setCustomColors({});
		main.setEditorTheme(undefined);
		assert.deepStrictEqual({ customized, restored: main.getColor(editorBackground)?.toString() }, { customized: '#123456', restored: '#202020' });
	});

	test('the interface view of the theme ignores the editor theme without changing it', () => {
		const { main, editor } = createThemes();
		main.setEditorTheme(editor);
		const interfaceTheme = main.getInterfaceTheme();
		assert.deepStrictEqual({
			interfaceEditorBackground: interfaceTheme.getColor(editorBackground)?.toString(),
			interfaceTokenBackground: interfaceTheme.tokenColors[0].settings.background,
			activeEditorBackground: main.getColor(editorBackground)?.toString(),
			sameWithoutEditorTheme: ColorThemeData.createUnloadedTheme('vs-dark').getInterfaceTheme().id,
		}, {
			interfaceEditorBackground: '#202020',
			interfaceTokenBackground: '#202020',
			activeEditorBackground: '#ffffff',
			sameWithoutEditorTheme: 'vs-dark',
		});
	});

	test('only editor colors are taken from the editor theme', () => {
		assert.deepStrictEqual(
			['editor.background', 'editorCursor.foreground', 'editorLineNumber.foreground', 'diffEditor.insertedTextBackground', 'minimap.background'].map(isEditorColor),
			[true, true, true, true, true]
		);
		assert.deepStrictEqual(
			['editorWidget.background', 'editorGroup.border', 'sideBar.background', 'tab.activeBackground', 'input.background', 'terminal.background'].map(isEditorColor),
			[false, false, false, false, false, false]
		);
	});
});
