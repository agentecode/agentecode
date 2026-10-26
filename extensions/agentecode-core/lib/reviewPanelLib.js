/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Apoio da tela "Alteracoes do agente" (sem VS Code): selo de linguagem de cada arquivo.

const path = require('path');

/** Extensao -> [texto do selo, cor de fundo, cor do texto]. */
const BADGES = {
	'.js': ['JS', '#f1e05a', '#1b1b1b'],
	'.mjs': ['JS', '#f1e05a', '#1b1b1b'],
	'.cjs': ['JS', '#f1e05a', '#1b1b1b'],
	'.ts': ['TS', '#3178c6', '#ffffff'],
	'.tsx': ['TSX', '#3178c6', '#ffffff'],
	'.jsx': ['JSX', '#f1e05a', '#1b1b1b'],
	'.json': ['JSO', '#cbcb41', '#1b1b1b'],
	'.md': ['MD', '#519aba', '#ffffff'],
	'.yml': ['YML', '#cb171e', '#ffffff'],
	'.yaml': ['YML', '#cb171e', '#ffffff'],
	'.css': ['CSS', '#563d7c', '#ffffff'],
	'.scss': ['CSS', '#c6538c', '#ffffff'],
	'.html': ['HTM', '#e34c26', '#ffffff'],
	'.py': ['PY', '#3572a5', '#ffffff'],
	'.cs': ['C#', '#178600', '#ffffff'],
	'.go': ['GO', '#00add8', '#ffffff'],
	'.sh': ['SH', '#89e051', '#1b1b1b'],
	'.ps1': ['PS', '#012456', '#ffffff'],
	'.sql': ['SQL', '#e38c00', '#1b1b1b'],
	'.xml': ['XML', '#0060ac', '#ffffff'],
	'.txt': ['TXT', '#6e7681', '#ffffff']
};

/**
 * Selo de linguagem de um arquivo.
 * @param {string} file
 * @returns {{ text: string, background: string, color: string }}
 */
function languageBadge(file) {
	const base = path.basename(file).toLowerCase();
	if (base === 'dockerfile') {
		return { text: 'DOC', background: '#2496ed', color: '#ffffff' };
	}
	if (base === 'makefile') {
		return { text: 'MAK', background: '#6d8086', color: '#ffffff' };
	}
	if (base.startsWith('.git')) {
		return { text: 'GIT', background: '#f05033', color: '#ffffff' };
	}
	const known = BADGES[path.extname(base)];
	if (known) {
		return { text: known[0], background: known[1], color: known[2] };
	}
	const ext = path.extname(base).replace('.', '').toUpperCase().slice(0, 3);
	return { text: ext || '?', background: '#6e7681', color: '#ffffff' };
}

module.exports = { languageBadge };
