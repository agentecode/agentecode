/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { t, getLanguage } = require('./i18n');

/** Pasta de dados do Claude Code (respeita CLAUDE_CONFIG_DIR). */
function claudeConfigDir() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Nome da pasta de projeto do Claude Code: todo caractere não alfanumérico vira "-". */
function projectSlug(folderPath) {
	return folderPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Lista as sessões (arquivos .jsonl) mais recentes. Com `workspaceFolders`, só as desses projetos;
 * sem, todas. A comparação do nome da pasta ignora maiúsculas (o Windows varia a letra da unidade).
 * @param {string[]} workspaceFolders
 * @param {number} limit
 * @returns {Promise<{ file: string, id: string, mtime: number, size: number }[]>}
 */
async function listSessionFiles(workspaceFolders, limit = 40) {
	const root = path.join(claudeConfigDir(), 'projects');
	let dirs;
	try {
		dirs = await fs.promises.readdir(root);
	} catch {
		return [];
	}
	const wanted = new Set(workspaceFolders.map(f => projectSlug(f).toLowerCase()));
	const selected = wanted.size ? dirs.filter(d => wanted.has(d.toLowerCase())) : dirs;

	const found = [];
	for (const dir of selected) {
		let entries;
		try {
			entries = await fs.promises.readdir(path.join(root, dir));
		} catch {
			continue;
		}
		for (const name of entries.filter(n => n.endsWith('.jsonl'))) {
			const file = path.join(root, dir, name);
			try {
				const stat = await fs.promises.stat(file);
				found.push({ file, id: name.slice(0, -'.jsonl'.length), mtime: stat.mtimeMs, size: stat.size });
			} catch {
				// arquivo removido durante a leitura
			}
		}
	}
	return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/**
 * Lê um .jsonl linha a linha, ignorando linhas inválidas.
 * @param {string} file
 * @param {(entry: any, line: string) => void} onEntry
 * @param {(line: string) => boolean} [accept] filtro barato sobre o texto, antes do JSON.parse
 */
async function readEntries(file, onEntry, accept) {
	const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line || (accept && !accept(line))) {
			continue;
		}
		try {
			onEntry(JSON.parse(line), line);
		} catch {
			// linha truncada ou corrompida
		}
	}
}

/** @param {any} content */
function firstText(content) {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
	}
	return '';
}

/**
 * Título e data de uma sessão, para a lista de escolha.
 * @param {string} file
 * @returns {Promise<{ title: string, cwd?: string }>}
 */
async function readSessionSummary(file) {
	let title;
	let firstPrompt;
	let cwd;
	await readEntries(file, entry => {
		if (entry.type === 'ai-title' && entry.aiTitle) {
			title = entry.aiTitle;
		} else if (entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
			cwd ??= entry.cwd;
			firstPrompt ??= firstText(entry.message?.content).trim().split('\n')[0];
		}
	}, line => line.includes('"type":"ai-title"') || line.includes('"type":"user"'));
	return { title: title || firstPrompt?.slice(0, 80) || t('Untitled session'), cwd };
}

/** Cerca de código com mais crases do que qualquer trecho do conteúdo. */
function fence(text) {
	const longest = Math.max(2, ...(String(text).match(/`+/g) ?? []).map(run => run.length));
	return '`'.repeat(longest + 1);
}

function codeBlock(text, lang = '') {
	const f = fence(text);
	return `${f}${lang}\n${text}\n${f}`;
}

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max)}\n${t('… ({0} characters omitted)', text.length - max)}` : text;
}

/** Resumo de uma chamada de ferramenta em uma linha. */
function describeToolUse(block) {
	const input = block.input ?? {};
	const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
	if (typeof detail === 'string') {
		return `**${block.name}** — \`${detail.replace(/\s+/g, ' ').replace(/`/g, '\'').slice(0, 200)}\``;
	}
	return `**${block.name}**`;
}

/** @param {any} content conteúdo de um tool_result */
function toolResultText(content) {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map(b => b?.type === 'text' ? b.text : `[${b?.type ?? t('content')}]`).join('\n');
	}
	return '';
}

function formatTime(timestamp) {
	const date = new Date(timestamp);
	return isNaN(date.getTime()) ? '' : date.toLocaleString(getLanguage() === 'pt' ? 'pt-BR' : 'en-US');
}

/**
 * Converte as entradas de uma sessão do Claude Code em Markdown.
 * @param {any[]} entries
 * @param {{ title?: string, sessionId?: string, includeToolResults?: boolean, maxToolResultChars?: number }} options
 * @returns {string}
 */
function sessionToMarkdown(entries, options = {}) {
	const { includeToolResults = true, maxToolResultChars = 1500 } = options;
	const messages = entries.filter(e => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain && !e.isMeta && e.message);

	const stamps = messages.map(m => m.timestamp).filter(Boolean).sort();
	const models = [...new Set(messages.filter(m => m.type === 'assistant').map(m => m.message.model).filter(Boolean))];
	const first = messages.find(m => m.cwd) ?? {};
	const branch = [...messages].reverse().find(m => m.gitBranch)?.gitBranch;
	const prompts = messages.filter(m => m.type === 'user' && firstText(m.message.content).trim()).length;

	const out = [`# ${options.title || t('Agent session')}`, ''];
	const meta = [
		[t('Session'), options.sessionId],
		[t('Project'), first.cwd && `\`${first.cwd}\``],
		['Branch', branch && `\`${branch}\``],
		[t('Model'), models.join(', ')],
		[t('Period'), stamps.length ? `${formatTime(stamps[0])} → ${formatTime(stamps[stamps.length - 1])}` : ''],
		[t('User messages'), String(prompts)],
	].filter(([, value]) => value);
	for (const [key, value] of meta) {
		out.push(`- **${key}:** ${value}`);
	}
	out.push('', t('_Exported from AgenteCode on {0}._', formatTime(Date.now())), '', '---', '');

	/** @type {'user' | 'assistant' | undefined} */
	let speaker;
	const speakerHeading = (role, timestamp) => {
		if (role !== speaker) {
			speaker = role;
			const when = formatTime(timestamp);
			out.push(`## ${role === 'user' ? t('User') : 'Claude'}${when ? ` · ${when}` : ''}`, '');
		}
	};

	for (const message of messages) {
		const content = message.message.content;
		const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

		for (const block of blocks) {
			switch (block.type) {
				case 'text': {
					const text = (block.text ?? '').trim();
					if (text) {
						speakerHeading(message.type, message.timestamp);
						out.push(text, '');
					}
					break;
				}
				case 'image':
					speakerHeading(message.type, message.timestamp);
					out.push(t('_[attached image]_'), '');
					break;
				case 'tool_use':
					speakerHeading('assistant', message.timestamp);
					out.push(`> ${describeToolUse(block)}`, '');
					break;
				case 'tool_result': {
					if (!includeToolResults) {
						break;
					}
					const text = toolResultText(block.content).trim();
					if (text) {
						const status = block.is_error ? t('error') : t('result');
						out.push(`<details><summary>${t('{0} ({1} characters)', status, text.length)}</summary>`, '', codeBlock(truncate(text, maxToolResultChars)), '', '</details>', '');
					}
					break;
				}
				// "thinking" e demais blocos internos ficam de fora
			}
		}
	}
	return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * Lê e converte um arquivo de sessão.
 * @param {string} file
 * @param {Parameters<typeof sessionToMarkdown>[1]} options
 */
async function exportSessionFile(file, options) {
	const entries = [];
	await readEntries(file, entry => {
		if (entry.type === 'user' || entry.type === 'assistant') {
			entries.push(entry);
		}
	}, line => line.includes('"type":"user"') || line.includes('"type":"assistant"'));
	return sessionToMarkdown(entries, options);
}

/** Nome de arquivo seguro a partir de um título. */
function slugify(text) {
	return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'sessao';
}

module.exports = { claudeConfigDir, projectSlug, listSessionFiles, readSessionSummary, readEntries, sessionToMarkdown, exportSessionFile, slugify };
