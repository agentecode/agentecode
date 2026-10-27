/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { registerExport } = require('./lib/export');
const { registerSessionsView } = require('./lib/sessionsView');
const { registerReleaseNotes } = require('./lib/releaseNotesView');
const { registerUsage } = require('./lib/usage/usage');
const { registerSync } = require('./lib/sync/index');
const { registerUsageHistory } = require('./lib/usageHistoryView');
const { registerReviewView } = require('./lib/reviewView');
const { resolveLanguage, setLanguage } = require('./lib/i18n');

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
	const vscode = require('vscode');
	const applyLanguage = () => setLanguage(resolveLanguage(
		vscode.workspace.getConfiguration('agentecode').get('language'),
		vscode.env.language
	));
	applyLanguage();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('agentecode.language')) {
			applyLanguage();
		}
	}));
	registerExport(context);
	registerSessionsView(context);
	registerReleaseNotes(context);
	registerUsage(context);
	registerSync(context);
	registerUsageHistory(context);
	registerReviewView(context);
}

function deactivate() { }

module.exports = { activate, deactivate };
