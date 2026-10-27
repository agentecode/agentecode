/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Languages supported by the AgenteCode texts that do not go through the VS Code localization system.
 */
export type AgenteCodeLanguage = 'en' | 'pt';

/**
 * Resolves the language of the AgenteCode texts.
 *
 * @param setting Value of the `agentecode.language` setting (`auto`, `en` or `pt-BR`).
 * @param displayLanguage Display language of VS Code (for example `pt-br` or `en`).
 * @returns `en` for the `en` setting, `pt` for `pt-BR` (or `pt`), and for `auto` or an empty value `pt` when the
 * display language starts with `pt`, otherwise `en`.
 */
export function resolveAgenteCodeLanguage(setting: string | undefined, displayLanguage: string | undefined): AgenteCodeLanguage {
	const normalizedSetting = (setting ?? '').trim().toLowerCase();
	if (normalizedSetting === 'en') {
		return 'en';
	}
	if (normalizedSetting === 'pt-br' || normalizedSetting === 'pt') {
		return 'pt';
	}
	return (displayLanguage ?? '').trim().toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

/**
 * Picks the text for the given language.
 */
export function agenteCodeText(language: AgenteCodeLanguage, texts: { en: string; pt: string }): string {
	return language === 'pt' ? texts.pt : texts.en;
}
