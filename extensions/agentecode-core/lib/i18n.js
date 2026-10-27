/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Traducao dos textos do AgenteCode. O texto-fonte no codigo e em ingles; a traducao para portugues (pt-BR) fica em
// lib/locales/pt-br/. Sem VS Code: o idioma e definido por quem ativa a extensao com setLanguage().

const ptBr = require('./locales/pt-br');

/** @type {'en' | 'pt'} */
let current = 'en';

/**
 * Escolhe o idioma: a configuracao `agentecode.language` ('auto', 'en' ou 'pt-BR') ou, em 'auto', o idioma de
 * exibicao do VS Code (o mesmo do pacote de idioma instalado), como qualquer extensao do VS Code.
 * @param {string | undefined} setting
 * @param {string | undefined} displayLanguage idioma de exibicao do VS Code (vscode.env.language)
 * @returns {'en' | 'pt'}
 */
function resolveLanguage(setting, displayLanguage) {
	if (setting === 'en') {
		return 'en';
	}
	if (setting === 'pt-BR' || setting === 'pt') {
		return 'pt';
	}
	return String(displayLanguage || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

/** @param {'en' | 'pt'} language */
function setLanguage(language) {
	current = language === 'pt' ? 'pt' : 'en';
}

/** @returns {'en' | 'pt'} */
function getLanguage() {
	return current;
}

/**
 * Devolve o texto no idioma atual. O proprio texto em ingles e a chave; `{0}`, `{1}`... sao substituidos pelos argumentos.
 * @param {string} english
 * @param {...(string | number)} args
 * @returns {string}
 */
function t(english, ...args) {
	const text = current === 'pt' && Object.prototype.hasOwnProperty.call(ptBr, english) ? ptBr[english] : english;
	return args.length ? text.replace(/\{(\d+)\}/g, (match, index) => (args[Number(index)] !== undefined ? String(args[Number(index)]) : match)) : text;
}

module.exports = { resolveLanguage, setLanguage, getLanguage, t };
