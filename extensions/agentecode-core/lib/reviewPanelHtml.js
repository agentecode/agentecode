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
		const stateIcon = el('span', 'state ' + item.status, item.status === 'added' ? '+' : item.status === 'deleted' ? '−' : '●');
		stateIcon.title = item.status === 'added' ? 'Arquivo novo' : item.status === 'deleted' ? 'Arquivo excluído' : 'Arquivo modificado';
		row.appendChild(stateIcon);
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
.state{width:14px;height:14px;box-sizing:border-box;border:1.5px solid;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;line-height:1;flex:none}
.state.added{color:#56d364}.state.modified{color:#e3b341}.state.deleted{color:#ff7b72}
.state.modified{font-size:8px}
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
