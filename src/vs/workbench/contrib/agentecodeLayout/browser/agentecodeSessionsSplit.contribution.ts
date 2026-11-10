/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
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

/** True while Agent Sessions is in the primary side bar (split from Claude Code). */
const SessionsSplitContext = new RawContextKey<boolean>('agentecode.sessionsSplit', false);

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
	if (to === ViewContainerLocation.Sidebar && viewDescriptorService.getViewContainerById(CLAUDE_CONTAINER_ID)) {
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
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('view', SESSIONS_VIEW_ID), SessionsSplitContext.negate()),
				group: 'navigation',
				order: 0
			}
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
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('view', SESSIONS_VIEW_ID), SessionsSplitContext),
				group: 'navigation',
				order: 0
			}
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return moveSessions(accessor, ViewContainerLocation.AuxiliaryBar);
	}
});

/** Keeps the context key in sync with where the Agent Sessions container currently is. */
class AgenteCodeSessionsSplitContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentecodeSessionsSplit';

	private readonly splitKey: IContextKey<boolean>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService
	) {
		super();
		this.splitKey = SessionsSplitContext.bindTo(contextKeyService);
		this.update();
		this._register(this.viewDescriptorService.onDidChangeContainerLocation(() => this.update()));
		this._register(this.viewDescriptorService.onDidChangeViewContainers(() => this.update()));
	}

	private update(): void {
		const sessions = this.viewDescriptorService.getViewContainerById(SESSIONS_CONTAINER_ID);
		this.splitKey.set(!!sessions && this.viewDescriptorService.getViewContainerLocation(sessions) === ViewContainerLocation.Sidebar);
	}
}

registerWorkbenchContribution2(AgenteCodeSessionsSplitContribution.ID, AgenteCodeSessionsSplitContribution, WorkbenchPhase.AfterRestored);
