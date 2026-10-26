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

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
	registerExport(context);
	registerSessionsView(context);
	registerReleaseNotes(context);
	registerUsage(context);
	registerSync(context);
	registerUsageHistory(context);
}

function deactivate() { }

module.exports = { activate, deactivate };
