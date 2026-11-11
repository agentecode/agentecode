/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { agenteCodeText, resolveAgenteCodeLanguage } from '../../../../base/common/agentecodeLanguage.js';
import { language as displayLanguage } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

export interface IAgenteCodeLinkAction {
	readonly action: 'open' | 'reveal' | 'copyPath' | 'copyLink';
	readonly href: string;
}

/**
 * Turns the `href` of a link in the Claude Code chat into a file resource.
 * Accepts `file:` URIs, absolute paths (`C:/dir/a.md`, `/dir/a.md`) and paths relative to the first workspace folder
 * (`.claude/a.md`, `../../Users/me/a.md`). A trailing `#fragment` or `:line[:column]` is dropped.
 */
export function resolveAgenteCodeLink(href: string, workspaceFolder: URI | undefined): URI | undefined {
	const trimmed = href.trim();
	if (/^file:/i.test(trimmed)) {
		return URI.parse(trimmed);
	}

	let value = trimmed;
	try {
		value = decodeURIComponent(value);
	} catch {
		// not percent-encoded: keep as is
	}
	value = value.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '');

	if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')) {
		return URI.file(value);
	}
	return workspaceFolder ? URI.joinPath(workspaceFolder, ...value.split(/[\\/]/).filter(part => part.length > 0)) : undefined;
}

/**
 * Runs the actions chosen on a link to a local file in the Claude Code chat (Ctrl+click and the link context menu).
 */
export class AgenteCodeLinkActionHandler {

	constructor(
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IEditorService private readonly editorService: IEditorService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	async handle({ action, href }: IAgenteCodeLinkAction): Promise<void> {
		if (action === 'copyLink') {
			await this.clipboardService.writeText(href);
			return;
		}

		const resource = resolveAgenteCodeLink(href, this.workspaceContextService.getWorkspace().folders[0]?.uri);
		if (!resource || !(await this.fileService.exists(resource))) {
			const language = resolveAgenteCodeLanguage(this.configurationService.getValue<string>('agentecode.language'), displayLanguage);
			this.notificationService.warn(agenteCodeText(language, {
				en: `File not found: ${resource?.fsPath ?? href}`,
				pt: `Arquivo nao encontrado: ${resource?.fsPath ?? href}`
			}));
			return;
		}

		switch (action) {
			case 'open':
				await this.editorService.openEditor({ resource, options: { pinned: true } });
				break;
			case 'reveal':
				await this.nativeHostService.showItemInFolder(resource.fsPath);
				break;
			case 'copyPath':
				await this.clipboardService.writeText(resource.fsPath);
				break;
		}
	}
}
