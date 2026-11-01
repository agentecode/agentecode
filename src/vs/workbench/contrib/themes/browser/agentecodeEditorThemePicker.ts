/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { language as displayLanguage } from '../../../../base/common/platform.js';
import { agenteCodeText, resolveAgenteCodeLanguage } from '../../../../base/common/agentecodeLanguage.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { ColorScheme, isHighContrast } from '../../../../platform/theme/common/theme.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';

const LANGUAGE_KEY = 'agentecode.language';
const MATCH_ITEM_ID = 'agentecode.editorTheme.match';
const PREVIEW_DELAY_MS = 200;

interface IEditorThemePick extends IQuickPickItem {
	/** `undefined` is the "match the interface theme" entry. */
	readonly theme: IWorkbenchColorTheme | undefined;
}

/**
 * "Editor Theme": picks a color theme used only by the code editors (colors and syntax), while the rest of the workbench,
 * the agent panel included, keeps the color theme. Arrow keys preview, Enter applies, Escape goes back.
 */
export async function pickEditorTheme(accessor: ServicesAccessor): Promise<void> {
	const themeService = accessor.get(IWorkbenchThemeService);
	const quickInputService = accessor.get(IQuickInputService);
	const configurationService = accessor.get(IConfigurationService);

	const text = (texts: { en: string; pt: string }) => agenteCodeText(resolveAgenteCodeLanguage(configurationService.getValue<string>(LANGUAGE_KEY), displayLanguage), texts);

	const themes = await themeService.getColorThemes();
	const original = themeService.getEditorColorTheme();

	const groupOf = (group: IWorkbenchColorTheme[], label: string): QuickPickInput<IEditorThemePick>[] => group.length === 0 ? [] : [
		{ type: 'separator', label },
		...[...group].sort((a, b) => a.label.localeCompare(b.label)).map((theme): IEditorThemePick => ({ id: theme.id, label: theme.label, description: theme.description, theme }))
	];

	const matchItem: IEditorThemePick = {
		id: MATCH_ITEM_ID,
		label: text({
			en: 'Match the interface theme',
			// allow-any-unicode-next-line
			pt: 'Corresponder ao tema da interface'
		}),
		theme: undefined
	};
	const picks: QuickPickInput<IEditorThemePick>[] = [
		matchItem,
		...groupOf(themes.filter(t => t.type === ColorScheme.DARK), text({ en: 'dark themes', pt: 'temas escuros' })),
		...groupOf(themes.filter(t => t.type === ColorScheme.LIGHT), text({ en: 'light themes', pt: 'temas claros' })),
		...groupOf(themes.filter(t => isHighContrast(t.type)), text({ en: 'high contrast themes', pt: 'temas de alto contraste' }))
	];

	const disposables = new DisposableStore();
	await new Promise<void>(resolve => {
		const quickpick = disposables.add(quickInputService.createQuickPick<IEditorThemePick>({ useSeparators: true }));
		quickpick.items = picks;
		quickpick.title = text({
			en: 'Editor Theme',
			// allow-any-unicode-next-line
			pt: 'Tema do editor'
		});
		quickpick.placeholder = text({
			en: 'Select the theme for the code editors (Up/Down Keys to Preview)',
			// allow-any-unicode-next-line
			pt: 'Escolha o tema dos editores de código (setas para visualizar)'
		});
		quickpick.matchOnDescription = true;
		quickpick.canSelectMany = false;
		quickpick.activeItems = [picks.find((pick): pick is IEditorThemePick => pick.type !== 'separator' && pick.id === (original ? original.id : MATCH_ITEM_ID)) ?? matchItem];

		let previewTimer: number | undefined;
		let accepted = false;
		const apply = (theme: IWorkbenchColorTheme | undefined, target: 'auto' | 'preview') => {
			if (previewTimer !== undefined) {
				mainWindow.clearTimeout(previewTimer);
				previewTimer = undefined;
			}
			themeService.setEditorColorTheme(theme, target).then(undefined, onUnexpectedError);
		};

		disposables.add(quickpick.onDidChangeActive(items => {
			if (previewTimer !== undefined) {
				mainWindow.clearTimeout(previewTimer);
			}
			const theme = items[0]?.theme;
			previewTimer = mainWindow.setTimeout(() => {
				previewTimer = undefined;
				themeService.setEditorColorTheme(theme, 'preview').then(undefined, onUnexpectedError);
			}, PREVIEW_DELAY_MS);
		}));
		disposables.add(quickpick.onDidAccept(() => {
			accepted = true;
			const selected = quickpick.selectedItems[0];
			if (selected) {
				apply(selected.theme, 'auto');
			}
			quickpick.hide();
		}));
		disposables.add(quickpick.onDidHide(() => {
			if (!accepted) {
				apply(original, 'preview');
			}
			resolve();
		}));
		quickpick.show();
	});
	disposables.dispose();
}
