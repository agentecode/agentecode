/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const DefaultViewTypes: readonly string[] = ['markhub'];

let viewTypePatterns: readonly string[] = DefaultViewTypes;

/**
 * Sets which extension webviews get the find widget (Ctrl+F) by default. Each entry is matched, ignoring case,
 * as a substring of the webview view type. Extensions that choose `enableFindWidget` themselves are not affected.
 */
export function setFindWidgetViewTypes(value: unknown): void {
	viewTypePatterns = Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).map(entry => entry.toLowerCase())
		: DefaultViewTypes;
}

/**
 * Whether a webview of the given view type should get the find widget when its extension did not decide.
 */
export function shouldEnableFindWidget(viewType: string | undefined): boolean {
	const lowerCased = (viewType ?? '').toLowerCase();
	return viewTypePatterns.some(pattern => lowerCased.includes(pattern));
}
