/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { setFindWidgetViewTypes } from './agentecodeFindWidget.js';

const FindWidgetViewTypesSetting = 'agentecode.webview.findWidget';

class AgenteCodeFindWidgetContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentecodeFindWidget';

	constructor(@IConfigurationService private readonly configurationService: IConfigurationService) {
		super();
		this.apply();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(FindWidgetViewTypesSetting)) {
				this.apply();
			}
		}));
	}

	private apply(): void {
		setFindWidgetViewTypes(this.configurationService.getValue(FindWidgetViewTypesSetting));
	}
}

registerWorkbenchContribution2(AgenteCodeFindWidgetContribution.ID, AgenteCodeFindWidgetContribution, WorkbenchPhase.BlockStartup);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentecodeWebview',
	order: 101,
	title: 'AgenteCode',
	type: 'object',
	properties: {
		[FindWidgetViewTypesSetting]: {
			type: 'array',
			items: { type: 'string' },
			default: ['markhub'],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('agentecode.webview.findWidget', "Extension webviews (such as Markdown previews) whose view type contains one of these names get the find widget (`Ctrl+F`), even when the extension does not enable it. Extensions that enable or disable it themselves are not affected.")
		}
	}
});
