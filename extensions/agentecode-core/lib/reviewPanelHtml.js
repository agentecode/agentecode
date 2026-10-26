/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Pagina (webview) da tela "Alteracoes do agente". O estado chega por mensagem e e desenhado no navegador
// com textContent (nenhum texto de arquivo vira HTML). Sem VS Code.

const CLIENT_SCRIPT = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) { node.className = cls; }
	if (text !== undefined) { node.textContent = text; }
	return node;
}
const STATE_ICONS = {
	added: 'M11.5 1H3.5C2.122 1 1 2.122 1 3.5V11.5C1 12.878 2.122 14 3.5 14H11.5C12.878 14 14 12.878 14 11.5V3.5C14 2.122 12.878 1 11.5 1ZM13 11.5C13 12.327 12.327 13 11.5 13H3.5C2.673 13 2 12.327 2 11.5V3.5C2 2.673 2.673 2 3.5 2H11.5C12.327 2 13 2.673 13 3.5V11.5ZM11 7.5C11 7.776 10.776 8 10.5 8H8V10.5C8 10.776 7.776 11 7.5 11C7.224 11 7 10.776 7 10.5V8H4.5C4.224 8 4 7.776 4 7.5C4 7.224 4.224 7 4.5 7H7V4.5C7 4.224 7.224 4 7.5 4C7.776 4 8 4.224 8 4.5V7H10.5C10.776 7 11 7.224 11 7.5Z',
	modified: 'M11 7.5C11 9.43 9.43 11 7.5 11C5.57 11 4 9.43 4 7.5C4 5.57 5.57 4 7.5 4C9.43 4 11 5.57 11 7.5ZM14 3.5V11.5C14 12.878 12.878 14 11.5 14H3.5C2.122 14 1 12.878 1 11.5V3.5C1 2.122 2.122 1 3.5 1H11.5C12.878 1 14 2.122 14 3.5ZM13 3.5C13 2.673 12.327 2 11.5 2H3.5C2.673 2 2 2.673 2 3.5V11.5C2 12.327 2.673 13 3.5 13H11.5C12.327 13 13 12.327 13 11.5V3.5Z',
	deleted: 'M11.5 1H3.5C2.122 1 1 2.122 1 3.5V11.5C1 12.878 2.122 14 3.5 14H11.5C12.878 14 14 12.878 14 11.5V3.5C14 2.122 12.878 1 11.5 1ZM13 11.5C13 12.327 12.327 13 11.5 13H3.5C2.673 13 2 12.327 2 11.5V3.5C2 2.673 2.673 2 3.5 2H11.5C12.327 2 13 2.673 13 3.5V11.5ZM11 7.5C11 7.776 10.776 8 10.5 8H4.5C4.224 8 4 7.776 4 7.5C4 7.224 4.224 7 4.5 7H10.5C10.776 7 11 7.224 11 7.5Z'
};
const STATE_TITLES = { added: 'Arquivo novo', modified: 'Arquivo modificado', deleted: 'Arquivo exclu\\u00eddo' };
function stateIcon(status) {
	const svgNs = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(svgNs, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('class', 'state ' + status);
	svg.setAttribute('fill', 'currentColor');
	const title = document.createElementNS(svgNs, 'title');
	title.textContent = STATE_TITLES[status] || '';
	svg.appendChild(title);
	const path = document.createElementNS(svgNs, 'path');
	path.setAttribute('d', STATE_ICONS[status] || STATE_ICONS.modified);
	svg.appendChild(path);
	return svg;
}
function send(message) { vscode.postMessage(message); }
function button(cls, label, title, onClick) {
	const b = el('button', cls, label);
	if (title) { b.title = title; }
	b.addEventListener('click', event => { event.stopPropagation(); onClick(); });
	return b;
}
function counts(added, removed) {
	const wrap = el('span', 'counts');
	if (added === null || removed === null) { return wrap; }
	if (added) { wrap.appendChild(el('span', 'add', '+' + added)); }
	if (removed) { wrap.appendChild(el('span', 'del', '\\u2212' + removed)); }
	return wrap;
}

function render(state) {
	root.textContent = '';
	const header = el('div', 'header');
	const total = el('div', 'total');
	total.appendChild(el('span', 'files', state.totals.files + (state.totals.files === 1 ? ' arquivo' : ' arquivos')));
	total.appendChild(counts(state.totals.added, state.totals.removed));
	header.appendChild(total);
	const bulk = el('div', 'bulk');
	const accept = button('accept', '\\u2713 Aceitar tudo', 'Marca todos os arquivos como revisados', () => send({ type: 'keepAll' }));
	const discard = button('discard', '\\u21b6 Descartar tudo', 'Volta todos os arquivos para o estado de antes (pede confirma\\u00e7\\u00e3o)', () => send({ type: 'revertAll' }));
	if (!state.totals.files) { accept.disabled = true; discard.disabled = true; }
	bulk.appendChild(accept);
	bulk.appendChild(discard);
	header.appendChild(bulk);
	root.appendChild(header);

	const tools = el('div', 'tools');
	tools.appendChild(button('link', 'Comparar com: ' + state.base + ' \\u25be', 'Escolher o ponto de compara\\u00e7\\u00e3o', () => send({ type: 'chooseBase' })));
	tools.appendChild(button('link', 'Trocar conversa', 'Escolher outra conversa do agente', () => send({ type: 'chooseSession' })));
	tools.appendChild(button('link', 'Atualizar', 'Recalcular agora', () => send({ type: 'refresh' })));
	root.appendChild(tools);

	if (state.conversation) { root.appendChild(el('div', 'sub', 'Conversa: ' + state.conversation)); }
	if (state.hiddenReviewed || state.showReviewed) {
		const line = el('div', 'sub');
		line.appendChild(document.createTextNode(state.hiddenReviewed + ' j\\u00e1 revisado(s) ' + (state.showReviewed ? 'vis\\u00edvel(is) ' : 'oculto(s) ')));
		line.appendChild(button('link', state.showReviewed ? 'ocultar' : 'mostrar', null, () => send({ type: 'toggleReviewed' })));
		root.appendChild(line);
	}

	if (!state.items.length) {
		root.appendChild(el('div', 'empty', state.emptyText));
	}

	const list = el('div', 'list');
	for (const item of state.items) {
		const row = el('div', 'row' + (item.reviewed ? ' reviewed' : ''));
		const chevron = button('chev', item.expanded ? '\\u25be' : '\\u25b8', 'Mostrar os trechos', () => send({ type: 'toggle', file: item.file }));
		if (item.status !== 'modified') { chevron.style.visibility = 'hidden'; }
		row.appendChild(chevron);
		row.appendChild(stateIcon(item.status));
		const badge = el('span', 'badge', item.badge.text);
		badge.style.background = item.badge.background;
		badge.style.color = item.badge.color;
		row.appendChild(badge);
		const name = el('span', 'name', item.name);
		name.title = item.file;
		name.addEventListener('click', () => send({ type: 'open', file: item.file }));
		row.appendChild(name);
		if (item.dir) { row.appendChild(el('span', 'dir', item.dir)); }
		if (item.status === 'added') { row.appendChild(el('span', 'tag new', 'NOVO')); }
		if (item.status === 'deleted') { row.appendChild(el('span', 'tag gone', 'EXCLU\\u00cdDO')); }
		row.appendChild(el('span', 'spacer'));
		row.appendChild(counts(item.added, item.removed));
		const actions = el('span', 'actions');
		actions.appendChild(button('icon keep', '\\u2713', 'Manter (marcar como revisado)', () => send({ type: 'keep', file: item.file })));
		actions.appendChild(button('icon undo', '\\u21b6', 'Voltar este arquivo', () => send({ type: 'revert', file: item.file })));
		row.appendChild(actions);
		row.addEventListener('dblclick', () => send({ type: 'open', file: item.file }));
		list.appendChild(row);

		if (item.expanded) {
			if (!item.hunks || !item.hunks.length) {
				list.appendChild(el('div', 'hunk none', 'Nenhum trecho pendente'));
			}
			for (const hunk of item.hunks || []) {
				const line = el('div', 'hunk');
				line.appendChild(el('span', 'at', '@linha ' + hunk.line));
				line.appendChild(el('span', 'spacer'));
				line.appendChild(counts(hunk.added, hunk.removed));
				const hunkActions = el('span', 'actions');
				hunkActions.appendChild(button('icon keep', '\\u2713', 'Manter este trecho', () => send({ type: 'keepHunk', file: item.file, key: hunk.key })));
				hunkActions.appendChild(button('icon undo', '\\u21b6', 'Desfazer este trecho', () => send({ type: 'undoHunk', file: item.file, key: hunk.key })));
				line.appendChild(hunkActions);
				line.addEventListener('click', () => send({ type: 'goto', file: item.file, line: hunk.line }));
				list.appendChild(line);
			}
		}
	}
	root.appendChild(list);
	root.appendChild(el('div', 'note', 'O que foi feito por comandos de terminal n\\u00e3o aparece aqui.'));
}

window.addEventListener('message', event => {
	if (event.data && event.data.type === 'state') { render(event.data.state); }
});
send({ type: 'ready' });
`;

const STYLE = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0 0 16px;margin:0}
button{font:inherit;cursor:pointer;color:inherit;background:transparent;border:0}
.header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px 4px;position:sticky;top:0;background:var(--vscode-sideBar-background,var(--vscode-editor-background));z-index:2}
.total{display:flex;align-items:baseline;gap:8px;font-weight:600}
.counts{display:inline-flex;gap:8px;font-variant-numeric:tabular-nums}
.add{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)}
.del{color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149)}
.bulk{display:flex;gap:6px}
.bulk button{padding:3px 10px;border-radius:4px;border:1px solid transparent;font-weight:600}
.bulk button.accept{background:#2ea043;border-color:#2ea043;color:#fff}
.bulk button.accept:hover:not(:disabled){background:#3fb950}
.bulk button.discard{background:rgba(248,81,73,.16);border-color:rgba(248,81,73,.55);color:#ff8b84}
.bulk button.discard:hover:not(:disabled){background:rgba(248,81,73,.3)}
.bulk button:disabled{opacity:.4;cursor:default}
.tools{display:flex;flex-wrap:wrap;gap:4px 14px;padding:2px 12px 6px}
.link{color:var(--vscode-textLink-foreground);padding:0;font-size:12px}
.link:hover{color:var(--vscode-textLink-activeForeground);text-decoration:underline}
.sub{color:var(--vscode-descriptionForeground);font-size:12px;padding:0 12px 2px}
.empty{padding:16px 12px;color:var(--vscode-descriptionForeground)}
.list{margin-top:4px}
.row,.hunk{display:flex;align-items:center;gap:6px;padding:2px 12px 2px 6px;min-height:24px}
.row:hover,.hunk:hover{background:var(--vscode-list-hoverBackground)}
.row.reviewed{opacity:.55}
.chev{width:16px;padding:0;color:var(--vscode-descriptionForeground)}
.state{flex:none}
.state.added{color:var(--vscode-gitDecoration-addedResourceForeground,#56d364)}
.state.modified{color:var(--vscode-gitDecoration-modifiedResourceForeground,#e2c08d)}
.state.deleted{color:var(--vscode-gitDecoration-deletedResourceForeground,#ff7b72)}
.badge{min-width:26px;text-align:center;font-size:10px;font-weight:700;border-radius:3px;padding:1px 3px;line-height:1.3}
.name{font-weight:600;cursor:pointer;white-space:nowrap}
.name:hover{text-decoration:underline}
.dir{color:var(--vscode-descriptionForeground);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:10px;font-weight:700;border-radius:3px;padding:0 5px;line-height:1.5}
.tag.new{background:rgba(46,160,67,.25);color:#56d364}
.tag.gone{background:rgba(248,81,73,.25);color:#ff7b72}
.spacer{flex:1}
.actions{display:none;gap:2px}
.row:hover .actions,.hunk:hover .actions{display:inline-flex}
.icon{width:20px;height:20px;border-radius:3px;font-size:13px;line-height:1}
.icon:hover{background:var(--vscode-toolbar-hoverBackground)}
.icon.keep{color:#56d364}.icon.undo{color:#ff7b72}
.hunk{padding-left:58px;font-size:12px;color:var(--vscode-descriptionForeground);cursor:pointer}
.hunk .at{font-family:var(--vscode-editor-font-family)}
.hunk.none{cursor:default}
.note{padding:10px 12px 0;color:var(--vscode-descriptionForeground);font-size:11px}
`;

/**
 * HTML completo da tela.
 * @param {{ nonce: string, cspSource: string }} options
 * @returns {string}
 */
function renderPanelHtml({ nonce, cspSource }) {
	return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${STYLE}</style></head><body><div id="root"></div><script nonce="${nonce}">${CLIENT_SCRIPT}</script></body></html>`;
}

module.exports = { renderPanelHtml, CLIENT_SCRIPT };
