/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { agenteCodeText, resolveAgenteCodeLanguage } from '../../../../base/common/agentecodeLanguage.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { language as displayLanguage } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import Severity from '../../../../base/common/severity.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

/**
 * Traz a janela do AgenteCode para a frente quando o Claude Code termina uma resposta. O aviso vem de um hook `Stop`
 * do Claude Code (instalado pelo comando "Install Claude Done Hook" da extensão agentecode-core), que grava
 * `~/.agentecode/claude-done.json` com o horário e a pasta de trabalho. Aqui só observamos esse arquivo.
 */

const MODE_KEY = 'agentecode.focusWhenDone';
const LANGUAGE_KEY = 'agentecode.language';
const COMMAND_CHOOSE = 'agentecode.focusWhenDone.choose';
const COMMAND_TOGGLE = 'agentecode.focusWhenDone.toggle';
const COMMAND_INSTALL_HOOK = 'agentecode.focusWhenDone.installHook';
const HOOK_MARKER = 'claude-done.js';
const ENTRY_ID = 'status.agentecode.focusWhenDone';
const LIST_ENTRY_ID = 'status.agentecode.focusWhenDone.options';
const SIGNAL_DIR = '.agentecode';
const SIGNAL_FILE = 'claude-done.json';
const POLL_MS = 1500;
/** Avisos mais velhos que isto (por exemplo, de uma sessão anterior) são ignorados. */
const MAX_AGE_MS = 30_000;

type FocusWhenDoneMode = 'off' | 'flash' | 'front';

/** Último modo ligado, usado quando o sino da barra de status religa a opção. */
let lastActiveMode: Exclude<FocusWhenDoneMode, 'off'> = 'front';

interface IDoneSignal {
	readonly t: number;
	readonly cwd: string;
}

function text(configurationService: IConfigurationService, texts: { en: string; pt: string }): string {
	const language = resolveAgenteCodeLanguage(configurationService.getValue<string>(LANGUAGE_KEY), displayLanguage);
	return agenteCodeText(language, texts);
}

function readMode(configurationService: IConfigurationService): FocusWhenDoneMode {
	const value = configurationService.getValue<string>(MODE_KEY);
	const mode: FocusWhenDoneMode = value === 'flash' || value === 'front' ? value : 'off';
	if (mode !== 'off') {
		lastActiveMode = mode;
	}
	return mode;
}

function parseSignal(content: string): IDoneSignal | undefined {
	try {
		const parsed = JSON.parse(content);
		if (typeof parsed?.t === 'number') {
			return { t: parsed.t, cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '' };
		}
	} catch {
		// arquivo ainda sendo gravado
	}
	return undefined;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** A pasta do aviso pertence a esta janela? Sem pasta aberta ou sem pasta no aviso, vale para qualquer janela. */
function belongsToWindow(cwd: string, folders: readonly string[]): boolean {
	if (!cwd || folders.length === 0) {
		return true;
	}
	const target = normalizePath(cwd);
	return folders.some(folder => {
		const root = normalizePath(folder);
		return target === root || target.startsWith(root + '/') || root.startsWith(target + '/');
	});
}

class AgenteCodeFocusWhenDoneContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentecodeFocusWhenDone';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly listEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly signalResource: URI;
	private lastSeen = Date.now();
	private polling = false;
	private promptedHook = false;
	private readonly claudeSettingsResource: URI;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IHostService private readonly hostService: IHostService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		this.signalResource = URI.joinPath(environmentService.userHome, SIGNAL_DIR, SIGNAL_FILE);
		this.claudeSettingsResource = URI.joinPath(environmentService.userHome, '.claude', 'settings.json');

		this.updateEntry();
		void this.checkHook();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(MODE_KEY) || event.affectsConfiguration(LANGUAGE_KEY)) {
				this.updateEntry();
			}
			if (event.affectsConfiguration(MODE_KEY)) {
				if (readMode(this.configurationService) === 'off') {
					this.promptedHook = false;
				} else {
					void this.checkHook();
				}
			}
		}));

		// clique direito no sino ou na seta: menu proprio no lugar do menu geral da barra de status
		this._register(addDisposableListener(mainWindow.document, 'contextmenu', (e: MouseEvent) => {
			const item = (e.target as HTMLElement | null)?.closest?.('.statusbar-item');
			if (item && (item.id === ENTRY_ID || item.id === LIST_ENTRY_ID)) {
				e.preventDefault();
				e.stopPropagation();
				this.showMenu(e);
			}
		}, true));

		const timer = mainWindow.setInterval(() => void this.poll(), POLL_MS);
		this._register({ dispose: () => mainWindow.clearInterval(timer) });
	}

	private updateEntry(): void {
		const mode = readMode(this.configurationService);
		const modeText = mode === 'off'
			? text(this.configurationService, { en: 'off', pt: 'desligado' })
			: mode === 'flash'
				? text(this.configurationService, { en: 'flash the taskbar', pt: 'piscar na barra de tarefas' })
				: text(this.configurationService, { en: 'bring to front', pt: 'trazer para a frente' });
		const props = {
			name: 'AgenteCode Focus When Done',
			text: mode === 'off' ? '$(bell-slash)' : '$(bell-dot)',
			tooltip: text(this.configurationService, { en: 'When Claude finishes: {0}. Click to turn on or off.', pt: 'Quando o Claude terminar: {0}. Clique para ligar ou desligar.' }).replace('{0}', modeText),
			ariaLabel: text(this.configurationService, { en: 'Notify when Claude finishes', pt: 'Avisar quando o Claude terminar' }),
			command: COMMAND_TOGGLE
		};
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			this.entry.value = this.statusbarService.addEntry(props, ENTRY_ID, StatusbarAlignment.RIGHT, 98);
		}
		const listProps = {
			name: 'AgenteCode Focus When Done Options',
			text: '$(chevron-down)',
			tooltip: text(this.configurationService, { en: 'Choose what happens when Claude finishes (Ctrl+Alt+Shift+N)', pt: 'Escolher o que acontece quando o Claude terminar (Ctrl+Alt+Shift+N)' }),
			ariaLabel: text(this.configurationService, { en: 'Choose what happens when Claude finishes', pt: 'Escolher o que acontece quando o Claude terminar' }),
			command: COMMAND_CHOOSE
		};
		if (this.listEntry.value) {
			this.listEntry.value.update(listProps);
		} else {
			this.listEntry.value = this.statusbarService.addEntry(listProps, LIST_ENTRY_ID, StatusbarAlignment.RIGHT, 97);
		}
	}

	private async hookInstalled(): Promise<boolean> {
		try {
			return (await this.fileService.readFile(this.claudeSettingsResource)).value.toString().includes(HOOK_MARKER);
		} catch {
			return false;
		}
	}

	/** Com a opção ligada e sem o hook do Claude Code, o aviso nunca chegaria: oferece instalar. */
	private async checkHook(): Promise<void> {
		if (this.promptedHook || readMode(this.configurationService) === 'off' || await this.hookInstalled()) {
			return;
		}
		this.promptedHook = true;
		this.notificationService.prompt(
			Severity.Info,
			// allow-any-unicode-next-line
			text(this.configurationService, { en: 'To be notified when Claude finishes, Claude Code has to tell this IDE. Install the notice now? It adds a Stop hook to the Claude Code settings and keeps a backup of the file.', pt: 'Para avisar quando o Claude terminar, o Claude Code precisa avisar esta IDE. Instalar o aviso agora? Ele adiciona um hook Stop nas configurações do Claude Code e guarda uma cópia de segurança do arquivo.' }),
			[{
				label: text(this.configurationService, { en: 'Install Now', pt: 'Instalar agora' }),
				run: () => this.commandService.executeCommand(COMMAND_INSTALL_HOOK, true)
			}],
			{ neverShowAgain: { id: 'agentecode.focusWhenDone.hookPrompt', isSecondary: true } }
		);
	}

	private showMenu(e: MouseEvent): void {
		const current = readMode(this.configurationService);
		const setMode = (mode: FocusWhenDoneMode) => this.configurationService.updateValue(MODE_KEY, mode, ConfigurationTarget.USER);
		const modeAction = (mode: FocusWhenDoneMode, label: string) => toAction({ id: `agentecode.focusWhenDone.mode.${mode}`, label, checked: current === mode, run: () => setMode(mode) });
		const actions: IAction[] = [
			modeAction('off', text(this.configurationService, { en: 'Off', pt: 'Desligado' })),
			modeAction('flash', text(this.configurationService, { en: 'Flash the taskbar', pt: 'Piscar na barra de tarefas' })),
			modeAction('front', text(this.configurationService, { en: 'Bring to front', pt: 'Trazer para a frente' })),
			new Separator(),
			toAction({ id: COMMAND_TOGGLE, label: text(this.configurationService, { en: 'Turn On or Off', pt: 'Ligar ou desligar' }), run: () => this.commandService.executeCommand(COMMAND_TOGGLE) }),
			toAction({ id: COMMAND_CHOOSE, label: text(this.configurationService, { en: 'Choose from a List...', pt: 'Escolher em uma lista...' }), run: () => this.commandService.executeCommand(COMMAND_CHOOSE) })
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => new StandardMouseEvent(mainWindow, e),
			getActions: () => actions,
			getKeyBinding: action => this.keybindingService.lookupKeybinding(action.id)
		});
	}

	private async poll(): Promise<void> {
		if (this.polling || readMode(this.configurationService) === 'off') {
			return;
		}
		this.polling = true;
		try {
			const stat = await this.fileService.resolve(this.signalResource, { resolveMetadata: true });
			if (stat.mtime <= this.lastSeen) {
				return;
			}
			const signal = parseSignal((await this.fileService.readFile(this.signalResource)).value.toString());
			if (!signal || signal.t <= this.lastSeen) {
				return;
			}
			this.lastSeen = Math.max(stat.mtime, signal.t);
			this.onDone(signal);
		} catch {
			// o arquivo só existe depois do primeiro aviso do hook
		} finally {
			this.polling = false;
		}
	}

	private onDone(signal: IDoneSignal): void {
		const mode = readMode(this.configurationService);
		if (mode === 'off' || Date.now() - signal.t > MAX_AGE_MS || this.hostService.hasFocus) {
			return;
		}
		const folders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri.fsPath);
		if (!belongsToWindow(signal.cwd, folders)) {
			return;
		}
		void this.hostService.focus(mainWindow, { mode: mode === 'front' ? FocusMode.Force : FocusMode.Notify });
	}
}

registerWorkbenchContribution2(AgenteCodeFocusWhenDoneContribution.ID, AgenteCodeFocusWhenDoneContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: COMMAND_TOGGLE,
			title: localize2('agentecode.focusWhenDone.toggle', "Toggle Notification When Claude Finishes"),
			category: Categories.View,
			f1: true,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyB }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const next = readMode(configurationService) === 'off' ? lastActiveMode : 'off';
		await configurationService.updateValue(MODE_KEY, next, ConfigurationTarget.USER);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: COMMAND_CHOOSE,
			title: localize2('agentecode.focusWhenDone.choose', "Choose What Happens When Claude Finishes"),
			category: Categories.View,
			f1: true,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyN }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);
		const current = readMode(configurationService);
		const items: (IQuickPickItem & { mode: FocusWhenDoneMode })[] = [
			{
				mode: 'off',
				label: text(configurationService, { en: 'Off', pt: 'Desligado' }),
				description: current === 'off' ? text(configurationService, { en: 'current', pt: 'atual' }) : undefined,
				// allow-any-unicode-next-line
				detail: text(configurationService, { en: 'Do nothing when Claude finishes.', pt: 'Não faz nada quando o Claude terminar.' })
			},
			{
				mode: 'flash',
				label: text(configurationService, { en: 'Flash the taskbar', pt: 'Piscar na barra de tarefas' }),
				description: current === 'flash' ? text(configurationService, { en: 'current', pt: 'atual' }) : undefined,
				// allow-any-unicode-next-line
				detail: text(configurationService, { en: 'The IDE icon flashes, without taking focus from what you are typing.', pt: 'O ícone da IDE pisca, sem tirar o foco do que você está digitando.' })
			},
			{
				mode: 'front',
				label: text(configurationService, { en: 'Bring to front', pt: 'Trazer para a frente' }),
				description: current === 'front' ? text(configurationService, { en: 'current', pt: 'atual' }) : undefined,
				detail: text(configurationService, { en: 'The IDE window comes in front of the other apps. Keys you type meanwhile can go to it.', pt: 'A janela da IDE vem para a frente dos outros aplicativos. Teclas digitadas nesse momento podem ir para ela.' })
			}
		];
		const picked = await quickInputService.pick(items, {
			// allow-any-unicode-next-line
			placeHolder: text(configurationService, { en: 'What should happen when Claude finishes a task? (needs the Claude Done hook)', pt: 'O que fazer quando o Claude terminar uma tarefa? (precisa do hook de término do Claude)' })
		});
		if (picked) {
			await configurationService.updateValue(MODE_KEY, picked.mode, ConfigurationTarget.USER);
		}
	}
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentecodeFocusWhenDone',
	order: 101,
	title: 'AgenteCode',
	type: 'object',
	properties: {
		[MODE_KEY]: {
			type: 'string',
			enum: ['off', 'flash', 'front'],
			enumDescriptions: [
				localize('agentecode.focusWhenDone.off', "Do nothing when Claude finishes."),
				localize('agentecode.focusWhenDone.flash', "Flash the taskbar icon."),
				localize('agentecode.focusWhenDone.front', "Bring the window in front of the other apps.")
			],
			default: 'off',
			description: localize('agentecode.focusWhenDone', "What the IDE does when Claude Code finishes a task while the IDE is not in focus. Needs the Claude Done hook (command \"Install Claude Done Hook\").")
		}
	}
});
