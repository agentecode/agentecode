/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

/**
 * The "Agent Sessions" view container (contributed by the agentecode-core extension) shares the secondary side bar with
 * Claude Code, so only one of them is visible at a time. These actions move Agent Sessions to the primary side bar
 * (split: both visible side by side) and back (join: tabs in the secondary side bar again).
 * The location is remembered by the view descriptor service, like any other moved view container.
 */

const SESSIONS_CONTAINER_ID = 'workbench.view.extension.agentecode-sessions';
const SESSIONS_VIEW_ID = 'agentecode.sessions';
const CLAUDE_CONTAINER_ID = 'workbench.view.extension.claude-sidebar-secondary';

const COMMAND_SPLIT = 'agentecode.sessions.split';
const COMMAND_JOIN = 'agentecode.sessions.join';
const COMMAND_STACK = 'agentecode.sessions.stack';
const COMMAND_SWAP = 'agentecode.sessions.swapStack';
const COMMAND_UNSTACK = 'agentecode.sessions.unstack';

const REVIEW_VIEW_ID = 'agentecode.reviewPanel';
const CLAUDE_VIEW_ID = 'claudeVSCodeSidebarSecondary';

/**
 * The buttons go in the title bar of the whole Agent Sessions window (its container), not in the Claude Code view.
 */
function titleMenus(when: ContextKeyExpression, order: number): { id: MenuId; when: ContextKeyExpression | undefined; group: string; order: number }[] {
	return [
		{ id: MenuId.ViewContainerTitle, when: ContextKeyExpr.and(ContextKeyExpr.equals('viewContainer', SESSIONS_CONTAINER_ID), when), group: 'navigation', order }
	];
}

/** True while Agent Sessions is in the primary side bar (split from Claude Code). */
const SessionsSplitContext = new RawContextKey<boolean>('agentecode.sessionsSplit', false);

/** True while the Claude Code view lives inside the Agent Sessions container (the two are stacked vertically). */
const SessionsStackedContext = new RawContextKey<boolean>('agentecode.sessionsStacked', false);

/** Whether Claude Code's view is currently inside the Agent Sessions container. */
function isStacked(viewDescriptorService: IViewDescriptorService): boolean {
	const sessions = viewDescriptorService.getViewContainerById(SESSIONS_CONTAINER_ID);
	const container = viewDescriptorService.getViewContainerByViewId(CLAUDE_VIEW_ID);
	return !!sessions && container?.id === sessions.id;
}

async function stackViews(accessor: ServicesAccessor): Promise<void> {
	const viewDescriptorService = accessor.get(IViewDescriptorService);
	const viewsService = accessor.get(IViewsService);
	const sessions = viewDescriptorService.getViewContainerById(SESSIONS_CONTAINER_ID);
	const claude = viewDescriptorService.getViewDescriptorById(CLAUDE_VIEW_ID);
	if (!sessions || !claude) {
		return;
	}
	if (!isStacked(viewDescriptorService)) {
		viewDescriptorService.moveViewsToContainer([claude], sessions, undefined, COMMAND_STACK);
	}
	await viewsService.openViewContainer(SESSIONS_CONTAINER_ID, true);
	arrangePanes(viewsService, false);
}

/**
 * Arranges the panes of the shared container as [Session History, Agent Changes, Claude Code] or [Claude Code, Session History,
 * Agent Changes], moving one pane past its neighbour at a time, so Claude Code is never between two Agent Sessions panes and
 * the Agent Sessions panes keep their default order.
 */
function arrangePanes(viewsService: IViewsService, claudeOnTop: boolean): void {
	const container = viewsService.getActiveViewPaneContainerWithId(SESSIONS_CONTAINER_ID);
	if (!(container instanceof ViewPaneContainer)) {
		return;
	}
	const wanted = claudeOnTop ? [CLAUDE_VIEW_ID, SESSIONS_VIEW_ID, REVIEW_VIEW_ID] : [SESSIONS_VIEW_ID, REVIEW_VIEW_ID, CLAUDE_VIEW_ID];
	const rank = (id: string) => {
		const index = wanted.indexOf(id);
		return index < 0 ? wanted.indexOf(REVIEW_VIEW_ID) + 0.5 : index;
	};
	for (let pass = 0; pass < 20; pass++) {
		const panes = container.panes;
		const i = panes.findIndex((pane, k) => k > 0 && rank(panes[k - 1].id) > rank(pane.id));
		if (i < 0) {
			return;
		}
		container.movePane(panes[i], panes[i - 1]);
	}
}

async function swapStack(accessor: ServicesAccessor): Promise<void> {
	const viewDescriptorService = accessor.get(IViewDescriptorService);
	const viewsService = accessor.get(IViewsService);
	if (!isStacked(viewDescriptorService)) {
		return;
	}
	await viewsService.openViewContainer(SESSIONS_CONTAINER_ID, false);
	const container = viewsService.getActiveViewPaneContainerWithId(SESSIONS_CONTAINER_ID);
	if (!(container instanceof ViewPaneContainer)) {
		return;
	}
	// From the top go to the bottom, from anywhere else go to the top
	arrangePanes(viewsService, container.panes[0]?.id !== CLAUDE_VIEW_ID);
}

async function unstackViews(accessor: ServicesAccessor): Promise<void> {
	const viewDescriptorService = accessor.get(IViewDescriptorService);
	const viewsService = accessor.get(IViewsService);
	const claude = viewDescriptorService.getViewDescriptorById(CLAUDE_VIEW_ID);
	const home = viewDescriptorService.getDefaultContainerById(CLAUDE_VIEW_ID);
	if (!claude || !home || !isStacked(viewDescriptorService)) {
		return;
	}
	await viewsService.openViewContainer(SESSIONS_CONTAINER_ID, false);
	arrangePanes(viewsService, false);
	viewDescriptorService.moveViewsToContainer([claude], home, undefined, COMMAND_UNSTACK);
	await viewsService.openViewContainer(home.id, false);
}

async function moveSessions(accessor: ServicesAccessor, to: ViewContainerLocation): Promise<void> {
	const viewDescriptorService = accessor.get(IViewDescriptorService);
	const viewsService = accessor.get(IViewsService);

	const sessions = viewDescriptorService.getViewContainerById(SESSIONS_CONTAINER_ID);
	if (!sessions) {
		return;
	}
	if (viewDescriptorService.getViewContainerLocation(sessions) !== to) {
		viewDescriptorService.moveViewContainerToLocation(sessions, to, undefined, to === ViewContainerLocation.Sidebar ? COMMAND_SPLIT : COMMAND_JOIN);
	}
	await viewsService.openViewContainer(SESSIONS_CONTAINER_ID, true);

	// When split, keep Claude Code showing in the secondary side bar
	if (to === ViewContainerLocation.Sidebar && !isStacked(viewDescriptorService) && viewDescriptorService.getViewContainerById(CLAUDE_CONTAINER_ID)) {
		await viewsService.openViewContainer(CLAUDE_CONTAINER_ID, false);
	}
}

registerAction2(class SplitSessionsAction extends Action2 {
	constructor() {
		super({
			id: COMMAND_SPLIT,
			title: localize2('agentecode.sessions.split', "Split Agent Sessions Beside Claude Code"),
			category: Categories.View,
			icon: Codicon.layoutSidebarLeft,
			f1: true,
			precondition: SessionsSplitContext.negate(),
			menu: titleMenus(SessionsSplitContext.negate(), 0)
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return moveSessions(accessor, ViewContainerLocation.Sidebar);
	}
});

registerAction2(class JoinSessionsAction extends Action2 {
	constructor() {
		super({
			id: COMMAND_JOIN,
			title: localize2('agentecode.sessions.join', "Join Agent Sessions With Claude Code"),
			category: Categories.View,
			icon: Codicon.layoutSidebarRight,
			f1: true,
			precondition: SessionsSplitContext,
			menu: titleMenus(SessionsSplitContext, 0)
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return moveSessions(accessor, ViewContainerLocation.AuxiliaryBar);
	}
});

registerAction2(class StackSessionsAction extends Action2 {
	constructor() {
		super({
			id: COMMAND_STACK,
			title: localize2('agentecode.sessions.stack', "Stack Agent Sessions and Claude Code Vertically"),
			category: Categories.View,
			icon: Codicon.splitVertical,
			f1: true,
			precondition: SessionsStackedContext.negate(),
			menu: titleMenus(SessionsStackedContext.negate(), 1)
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return stackViews(accessor);
	}
});

registerAction2(class SwapStackAction extends Action2 {
	constructor() {
		super({
			id: COMMAND_SWAP,
			title: localize2('agentecode.sessions.swapStack', "Swap Agent Sessions and Claude Code Positions"),
			category: Categories.View,
			icon: Codicon.arrowSwap,
			f1: true,
			precondition: SessionsStackedContext,
			menu: titleMenus(SessionsStackedContext, 1)
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return swapStack(accessor);
	}
});

registerAction2(class UnstackSessionsAction extends Action2 {
	constructor() {
		super({
			id: COMMAND_UNSTACK,
			title: localize2('agentecode.sessions.unstack', "Separate Agent Sessions From Claude Code"),
			category: Categories.View,
			icon: Codicon.layoutSidebarRight,
			f1: true,
			precondition: SessionsStackedContext,
			menu: titleMenus(SessionsStackedContext, 2)
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return unstackViews(accessor);
	}
});

/** Keeps the context key in sync with where the Agent Sessions container currently is. */
class AgenteCodeSessionsSplitContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentecodeSessionsSplit';

	private readonly splitKey: IContextKey<boolean>;
	private readonly stackedKey: IContextKey<boolean>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService
	) {
		super();
		this.splitKey = SessionsSplitContext.bindTo(contextKeyService);
		this.stackedKey = SessionsStackedContext.bindTo(contextKeyService);
		this.update();
		this._register(this.viewDescriptorService.onDidChangeContainerLocation(() => this.update()));
		this._register(this.viewDescriptorService.onDidChangeViewContainers(() => this.update()));
		this._register(this.viewDescriptorService.onDidChangeContainer(() => this.update()));
	}

	private update(): void {
		const sessions = this.viewDescriptorService.getViewContainerById(SESSIONS_CONTAINER_ID);
		this.splitKey.set(!!sessions && this.viewDescriptorService.getViewContainerLocation(sessions) === ViewContainerLocation.Sidebar);
		this.stackedKey.set(isStacked(this.viewDescriptorService));
	}
}

registerWorkbenchContribution2(AgenteCodeSessionsSplitContribution.ID, AgenteCodeSessionsSplitContribution, WorkbenchPhase.AfterRestored);
