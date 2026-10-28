/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { match } from '../../base/common/glob.js';
import { URI } from '../../base/common/uri.js';

export const OpenWithDefaultEditorSetting = 'agentecode.editor.openWithDefaultEditor';

const DefaultPatterns: readonly string[] = ['**/*.md'];

/**
 * Whether a file that an extension opens as a text document (`showTextDocument`, for example a link clicked in a chat)
 * should use the editor the user would get by opening it normally (such as a Markdown preview) instead of the plain
 * text editor. `patterns` are glob patterns matched against the file path; invalid values fall back to the default.
 */
export function shouldOpenWithDefaultEditor(patterns: unknown, resource: URI): boolean {
	const list = Array.isArray(patterns)
		? patterns.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
		: DefaultPatterns;
	return list.some(pattern => match(pattern, resource.path));
}
