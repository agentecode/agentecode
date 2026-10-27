/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

import { mainWindow } from '../../../../base/browser/window.js';
import { agenteCodeText, resolveAgenteCodeLanguage } from '../../../../base/common/agentecodeLanguage.js';
import { language as displayLanguage } from '../../../../base/common/platform.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

/**
 * Layouts salvos do AgenteCode: larguras e alturas das partes da janela (barra lateral, barra lateral secundária
 * onde fica o Claude Code, e painel), guardadas como configuração de usuário. Assim vão junto no sincronismo
 * com o Gist, que já leva o settings.json.
 */

const SAVED_KEY = 'agentecode.layout.saved';
const LAST_KEY = 'agentecode.layout.last';
const AUTO_RESTORE_KEY = 'agentecode.layout.autoRestore';

const COMMAND_SAVE = 'agentecode.layout.save';
const COMMAND_SAVE_AS = 'agentecode.layout.saveAs';
const COMMAND_RESTORE = 'agentecode.layout.restore';
const COMMAND_RESTORE_LAST = 'agentecode.layout.restoreLast';

const LANGUAGE_KEY = 'agentecode.language';

/** Texto no idioma configurado em `agentecode.language` (com `auto`, o idioma de exibição do VS Code). Avaliado a cada uso. */
function layoutText(configurationService: IConfigurationService, texts: { en: string; pt: string }): string {
	const language = resolveAgenteCodeLanguage(configurationService.getValue<string>(LANGUAGE_KEY), displayLanguage);
	return agenteCodeText(language, texts);
}

function textNoLayout(configurationService: IConfigurationService): string {
	return layoutText(configurationService, {
		en: 'There is no saved layout yet. Use "Save Current Layout" first.',
		// allow-any-unicode-next-line
		pt: 'Ainda não há layout salvo. Use "Salvar layout" primeiro.'
	});
}

function textSaved(configurationService: IConfigurationService, name: string): string {
	return layoutText(configurationService, {
		en: `Layout "${name}" saved.`,
		pt: `Layout "${name}" salvo.`
	});
}

function textRestored(configurationService: IConfigurationService, name: string): string {
	return layoutText(configurationService, {
		en: `Layout "${name}" restored.`,
		pt: `Layout "${name}" restaurado.`
	});
}

function textRestoredAuto(configurationService: IConfigurationService, name: string): string {
	return layoutText(configurationService, {
		en: `Layout "${name}" applied for this screen.`,
		pt: `Layout "${name}" aplicado para esta tela.`
	});
}

interface IPartLayout {
	readonly visible: boolean;
	readonly width: number;
	readonly height: number;
}

interface ISavedLayout {
	readonly savedAt: number;
	/** Resolução da tela em que foi salvo (ex.: "2560x1440"). */
	readonly screen: string;
	/** Tamanho da janela quando foi salvo, para ajustar as medidas se a janela for diferente. */
	readonly innerWidth: number;
	readonly innerHeight: number;
	readonly parts: { readonly [part: string]: IPartLayout };
}

type SavedLayouts = { [name: string]: ISavedLayout };

const LAYOUT_PARTS: readonly { readonly key: string; readonly part: Parts }[] = [
	{ key: 'sidebar', part: Parts.SIDEBAR_PART },
	{ key: 'auxiliarybar', part: Parts.AUXILIARYBAR_PART },
	{ key: 'panel', part: Parts.PANEL_PART },
];

function screenKey(): string {
	return `${mainWindow.screen.width}x${mainWindow.screen.height}`;
}

function readLayouts(configurationService: IConfigurationService): SavedLayouts {
	const value = configurationService.getValue<SavedLayouts>(SAVED_KEY);
	return value && typeof value === 'object' ? value : {};
}

function captureLayout(layoutService: IWorkbenchLayoutService): ISavedLayout {
	const parts: { [part: string]: IPartLayout } = {};
	for (const { key, part } of LAYOUT_PARTS) {
		const visible = layoutService.isVisible(part, mainWindow);
		const size = layoutService.getSize(part);
		parts[key] = { visible, width: Math.round(size.width), height: Math.round(size.height) };
	}
	return { savedAt: Date.now(), screen: screenKey(), innerWidth: mainWindow.innerWidth, innerHeight: mainWindow.innerHeight, parts };
}

/** Aplica as medidas salvas, proporcionais ao tamanho atual da janela. */
function applyLayout(layoutService: IWorkbenchLayoutService, layout: ISavedLayout): void {
	const scaleX = layout.innerWidth > 0 ? mainWindow.innerWidth / layout.innerWidth : 1;
	const scaleY = layout.innerHeight > 0 ? mainWindow.innerHeight / layout.innerHeight : 1;

	for (const { key, part } of LAYOUT_PARTS) {
		const saved = layout.parts[key];
		if (!saved) {
			continue;
		}
		if (saved.visible !== layoutService.isVisible(part, mainWindow)) {
			layoutService.setPartHidden(!saved.visible, part);
		}
		if (!saved.visible) {
			continue;
		}
		const current = layoutService.getSize(part);
		const horizontalPanel = part === Parts.PANEL_PART && layoutService.getPanelPosition() !== Position.LEFT && layoutService.getPanelPosition() !== Position.RIGHT;
		layoutService.setSize(part, horizontalPanel
			? { width: current.width, height: Math.round(saved.height * scaleY) }
			: { width: Math.round(saved.width * scaleX), height: current.height });
	}
}

function nowName(): string {
	return screenKey();
}

interface ILayoutServices {
	readonly configurationService: IConfigurationService;
	readonly layoutService: IWorkbenchLayoutService;
	readonly notificationService: INotificationService;
}

function layoutServices(accessor: ServicesAccessor): ILayoutServices {
	return {
		configurationService: accessor.get(IConfigurationService),
		layoutService: accessor.get(IWorkbenchLayoutService),
		notificationService: accessor.get(INotificationService)
	};
}

async function saveLayout({ configurationService, layoutService, notificationService }: ILayoutServices, name: string): Promise<void> {
	const layouts = { ...readLayouts(configurationService), [name]: captureLayout(layoutService) };
	await configurationService.updateValue(SAVED_KEY, layouts, ConfigurationTarget.USER);
	await configurationService.updateValue(LAST_KEY, name, ConfigurationTarget.USER);
	notificationService.status(textSaved(configurationService, name), { hideAfter: 4000 });
}

function restoreLayout({ configurationService, layoutService, notificationService }: ILayoutServices, name: string): boolean {
	const layout = readLayouts(configurationService)[name];
	if (!layout) {
		return false;
	}
	applyLayout(layoutService, layout);
	notificationService.status(textRestored(configurationService, name), { hideAfter: 4000 });
	return true;
}

registerAction2(class SaveLayoutAction extends Action2 {
	constructor() {
		super({
			id: COMMAND_SAVE,
			title: localize2('agentecode.layout.save', "Save Current Layout"),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.GlobalActivity, group: '5_agentecode_layout', order: 1 },
			icon: Codicon.save,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyS }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await saveLayout(layoutServices(accessor), nowName());
	}
});

registerAction2(class SaveLayoutAsAction extends Action2 {
	constructor() {
		super({
			id: COMMAND_SAVE_AS,
			title: localize2('agentecode.layout.saveAs', "Save Layout As..."),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.GlobalActivity, group: '5_agentecode_layout', order: 2 }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const services = layoutServices(accessor);
		// allow-any-unicode-next-line
		const typed = await accessor.get(IQuickInputService).input({ prompt: layoutText(services.configurationService, { en: 'Layout name (empty uses the screen resolution)', pt: 'Nome do layout (vazio usa a resolução da tela)' }), placeHolder: nowName() });
		if (typed === undefined) {
			return;
		}
		await saveLayout(services, typed.trim() || nowName());
	}
});

registerAction2(class RestoreLayoutAction extends Action2 {
	constructor() {
		super({
			id: COMMAND_RESTORE,
			title: localize2('agentecode.layout.restore', "Restore Layout..."),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.GlobalActivity, group: '5_agentecode_layout', order: 4 },
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyL }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const services = layoutServices(accessor);
		const quickInputService = accessor.get(IQuickInputService);
		const { configurationService } = services;
		const layouts = readLayouts(configurationService);
		const names = Object.keys(layouts);
		if (!names.length) {
			services.notificationService.info(textNoLayout(configurationService));
			return;
		}
		const last = configurationService.getValue<string>(LAST_KEY);
		const items: IQuickPickItem[] = names
			.sort((a, b) => layouts[b].savedAt - layouts[a].savedAt)
			// allow-any-unicode-next-line
			.map(name => ({ label: name, description: name === last ? layoutText(configurationService, { en: '(last saved)', pt: '(último salvo)' }) : undefined, detail: `${layouts[name].screen} · ${new Date(layouts[name].savedAt).toLocaleString()}` }));
		const picked = await quickInputService.pick(items, { placeHolder: layoutText(configurationService, { en: 'Choose the layout to restore', pt: 'Escolha o layout para restaurar' }) });
		if (picked) {
			restoreLayout(services, picked.label);
		}
	}
});

registerAction2(class RestoreLastLayoutAction extends Action2 {
	constructor() {
		super({
			id: COMMAND_RESTORE_LAST,
			title: localize2('agentecode.layout.restoreLast', "Restore Last Saved Layout"),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.GlobalActivity, group: '5_agentecode_layout', order: 3 },
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyR }
		});
	}

	run(accessor: ServicesAccessor): void {
		const services = layoutServices(accessor);
		const last = services.configurationService.getValue<string>(LAST_KEY);
		if (!last || !restoreLayout(services, last)) {
			services.notificationService.info(textNoLayout(services.configurationService));
		}
	}
});

/**
 * Botões na barra de status e restauração automática quando a janela muda de monitor
 * (a resolução da tela muda e existe um layout salvo para ela).
 */
class AgenteCodeLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentecodeLayout';

	private readonly saveEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly restoreEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private lastScreen = screenKey();
	private resizeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		this.saveEntry.value = statusbarService.addEntry({
			name: 'AgenteCode Layout',
			text: '$(save)',
			tooltip: layoutText(configurationService, { en: 'Save current layout (Ctrl+Alt+Shift+S)', pt: 'Salvar layout atual (Ctrl+Alt+Shift+S)' }),
			ariaLabel: layoutText(configurationService, { en: 'Save current layout', pt: 'Salvar layout atual' }),
			command: COMMAND_SAVE
		}, 'status.agentecode.layout.save', StatusbarAlignment.RIGHT, 100);

		this.restoreEntry.value = statusbarService.addEntry({
			name: 'AgenteCode Layout',
			text: '$(layout)',
			// allow-any-unicode-next-line
			tooltip: layoutText(configurationService, { en: 'Restore the last saved layout (Ctrl+Alt+Shift+R)', pt: 'Restaurar o último layout salvo (Ctrl+Alt+Shift+R)' }),
			// allow-any-unicode-next-line
			ariaLabel: layoutText(configurationService, { en: 'Restore the last saved layout', pt: 'Restaurar o último layout salvo' }),
			command: COMMAND_RESTORE_LAST
		}, 'status.agentecode.layout.restore', StatusbarAlignment.RIGHT, 99);

		const onResize = () => {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = setTimeout(() => this.onMaybeMovedScreen(), 1500);
		};
		mainWindow.addEventListener('resize', onResize);
		this._register({ dispose: () => { mainWindow.removeEventListener('resize', onResize); clearTimeout(this.resizeTimer); } });

		// ao abrir, aplica o layout da tela atual, se houver
		this.onMaybeMovedScreen(true);
	}

	private onMaybeMovedScreen(startup = false): void {
		const current = screenKey();
		if (!startup && current === this.lastScreen) {
			return;
		}
		this.lastScreen = current;
		if (!this.configurationService.getValue<boolean>(AUTO_RESTORE_KEY)) {
			return;
		}
		const layout = readLayouts(this.configurationService)[current];
		if (layout) {
			applyLayout(this.layoutService, layout);
			this.notificationService.status(textRestoredAuto(this.configurationService, current), { hideAfter: 4000 });
		}
	}
}

registerWorkbenchContribution2(AgenteCodeLayoutContribution.ID, AgenteCodeLayoutContribution, WorkbenchPhase.AfterRestored);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentecodeLayout',
	order: 100,
	title: 'AgenteCode Layout',
	type: 'object',
	properties: {
		[SAVED_KEY]: {
			type: 'object',
			default: {},
			description: localize('agentecode.layout.saved', "Saved layouts (widths and heights of the side bars and the panel). Managed by the \"Save Current Layout\" commands; synced along with the Gist.")
		},
		[LAST_KEY]: {
			type: 'string',
			default: '',
			description: localize('agentecode.layout.last', "Name of the last saved layout, used by \"Restore Last Saved Layout\".")
		},
		[AUTO_RESTORE_KEY]: {
			type: 'boolean',
			default: true,
			description: localize('agentecode.layout.autoRestore', "When opening the IDE or moving the window to another monitor, applies the layout saved for that screen's resolution.")
		}
	}
});
