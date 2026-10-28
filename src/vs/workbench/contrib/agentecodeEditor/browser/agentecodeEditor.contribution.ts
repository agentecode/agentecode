/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { OpenWithDefaultEditorSetting } from '../../../common/agentecodeOpenWithDefaultEditor.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentecodeEditor',
	order: 102,
	title: 'AgenteCode',
	type: 'object',
	properties: {
		[OpenWithDefaultEditorSetting]: {
			type: 'array',
			items: { type: 'string' },
			default: ['**/*.md'],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('agentecode.editor.openWithDefaultEditor', "Glob patterns of files that open with their default editor (for example the Markdown preview) when an extension opens them, such as when you click a file link in the Claude Code chat. By default these files would always open as plain text. Use `[]` to turn this off.")
		}
	}
});
