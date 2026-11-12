/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Pagina (webview) da tela "Alteracoes do agente". O estado chega por mensagem e e desenhado no navegador
// com textContent (nenhum texto de arquivo vira HTML). Sem VS Code.

const { t, getLanguage } = require('./i18n');
const { filterTokens, itemMatchesFilter } = require('./reviewPanelLib');

const CLIENT_SCRIPT = `
// L (textos ja traduzidos) e injetado antes deste script por renderPanelHtml.
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
const STATE_TITLES = { added: L.stateAdded, modified: L.stateModified, deleted: L.stateDeleted };
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
function fmt(text, value) { return text.replace('{0}', value); }
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

${filterTokens.toString()}
${itemMatchesFilter.toString()}
let filterText = (vscode.getState() || {}).filter || '';
let lastState;
/** Trecho com a caixa de comentario aberta ({ file, key }) e o texto digitado, que sobrevive a atualizacoes da tela */
let editing = null;
let draft = '';
/** O mesmo arquivo pode aparecer em duas linhas (ex.: NEW e MODIFIED); a situacao separa o comentario de cada linha */
const fileKeyOf = item => '__file__:' + item.status;
const sameHunk = (a, b) => !!a && !!b && a.file === b.file && a.key === b.key;
const search = el('input', 'filter');
search.type = 'text';
search.placeholder = L.filterPlaceholder;
search.spellcheck = false;
search.value = filterText;
search.addEventListener('input', () => {
	filterText = search.value;
	vscode.setState({ filter: filterText });
	if (lastState) { render(lastState); }
});
search.addEventListener('keydown', event => {
	if (event.key === 'Escape' && search.value) {
		event.preventDefault();
		search.value = '';
		search.dispatchEvent(new Event('input'));
	}
});

function appendComment(list, file, key, comment, indent) {
	if (sameHunk(editing, { file, key })) {
		const box = el('div', 'commentbox');
		box.style.marginLeft = indent + 'px';
		const area = el('textarea', 'commentarea');
		area.rows = 3;
		area.placeholder = L.commentPlaceholder;
		area.value = draft;
		area.addEventListener('input', () => { draft = area.value; });
		const done = save => {
			const target = editing;
			editing = null;
			if (save) { send({ type: 'commentHunk', file: target.file, key: target.key, text: area.value }); } else { render(lastState); }
		};
		area.addEventListener('keydown', e => {
			if (e.key === 'Escape') { done(false); }
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { done(true); }
		});
		const bar = el('div', 'commentbtns');
		bar.appendChild(button('primary', L.commentSave, L.commentSaveTip, () => done(true)));
		bar.appendChild(button('plain', L.commentCancel, '', () => done(false)));
		if (comment) { bar.appendChild(button('plain', L.commentRemove, '', () => { editing = null; send({ type: 'commentHunk', file: file, key: key, text: '' }); })); }
		box.appendChild(area);
		box.appendChild(bar);
		list.appendChild(box);
		setTimeout(() => { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }, 0);
	} else if (comment) {
		const note = el('div', 'commenttext', comment);
		note.title = L.commentEditTip;
		note.style.marginLeft = indent + 'px';
		note.addEventListener('click', () => { editing = { file: file, key: key }; draft = comment; render(lastState); });
		list.appendChild(note);
	}
}

function render(state) {
	lastState = state;
	const hadFocus = document.activeElement === search;
	const caret = [search.selectionStart, search.selectionEnd];
	root.textContent = '';
	const tokens = filterTokens(filterText);
	const filtering = tokens.length > 0;
	const items = filtering ? state.items.filter(item => itemMatchesFilter(item, tokens)) : state.items;
	const shown = items.filter(item => !item.reviewed);
	const totals = filtering
		? { files: shown.length, added: shown.reduce((sum, item) => sum + (item.added || 0), 0), removed: shown.reduce((sum, item) => sum + (item.removed || 0), 0) }
		: state.totals;
	const header = el('div', 'header');
	const total = el('div', 'total');
	total.appendChild(el('span', 'files', filtering ? L.filesFiltered.replace('{0}', totals.files).replace('{1}', state.totals.files) : fmt(state.totals.files === 1 ? L.filesOne : L.filesMany, state.totals.files)));
	total.appendChild(counts(totals.added, totals.removed));
	header.appendChild(total);
	const bulk = el('div', 'bulk');
	// Com busca ligada, os botoes valem so para os arquivos que aparecem na lista
	const files = shown.map(item => item.file);
	const accept = filtering
		? button('accept', '\\u2713 ' + fmt(L.acceptShown, files.length), L.acceptShownTip, () => send({ type: 'keepFiles', files }))
		: button('accept', '\\u2713 ' + L.acceptAll, L.acceptAllTip, () => send({ type: 'keepAll' }));
	const discard = filtering
		? button('discard', '\\u21b6 ' + fmt(L.discardShown, files.length), L.discardShownTip, () => send({ type: 'revertFiles', files }))
		: button('discard', '\\u21b6 ' + L.discardAll, L.discardAllTip, () => send({ type: 'revertAll' }));
	if (!totals.files) { accept.disabled = true; discard.disabled = true; }
	bulk.appendChild(accept);
	bulk.appendChild(discard);
	header.appendChild(bulk);
	root.appendChild(header);

	const tools = el('div', 'tools');
	tools.appendChild(button('link', fmt(L.compareWith, state.base) + ' \\u25be', L.compareTip, () => send({ type: 'chooseBase' })));
	tools.appendChild(button('link', L.switchChat, L.switchChatTip, () => send({ type: 'chooseSession' })));
	tools.appendChild(button('link', L.sortBy + ' ' + (L.sortNames[state.sort] || L.sortNames.timeOldestFirst), L.sortTip, () => send({ type: 'cycleSort' })));
	tools.appendChild(button('link', L.refresh, L.refreshTip, () => send({ type: 'refresh' })));
	root.appendChild(tools);

	if (state.items.length || filterText) {
		const box = el('div', 'filterbox');
		box.appendChild(search);
		if (filterText) {
			box.appendChild(button('clear', '\\u00d7', L.clearFilter, () => { search.value = ''; search.dispatchEvent(new Event('input')); }));
		}
		root.appendChild(box);
	}

	if (state.conversation) { root.appendChild(el('div', 'sub', fmt(L.conversation, state.conversation))); }
	if (state.hiddenReviewed || state.showReviewed) {
		const line = el('div', 'sub');
		line.appendChild(document.createTextNode(fmt(state.showReviewed ? L.reviewedVisible : L.reviewedHidden, state.hiddenReviewed) + ' '));
		line.appendChild(button('link', state.showReviewed ? L.hide : L.show, null, () => send({ type: 'toggleReviewed' })));
		root.appendChild(line);
	}

	if (!state.items.length) {
		root.appendChild(el('div', 'empty', state.emptyText));
	} else if (!items.length) {
		root.appendChild(el('div', 'empty', L.noMatch));
	}

	const list = el('div', 'list');
	for (const item of items) {
		const row = el('div', 'row' + (item.reviewed ? ' reviewed' : ''));
		const chevron = button('chev', item.expanded ? '\\u25be' : '\\u25b8', L.showHunks, () => send({ type: 'toggle', file: item.file }));
		if (item.status !== 'modified') { chevron.style.visibility = 'hidden'; }
		row.appendChild(chevron);
		row.appendChild(stateIcon(item.status));
		const badge = el('span', 'badge', item.badge.text);
		badge.style.background = item.badge.background;
		badge.style.color = item.badge.color;
		row.appendChild(badge);
		const name = el('span', 'name', item.name);
		name.title = item.file + '\\n' + L.nameTip;
		// clique abre a diferenca; Ctrl, Cmd ou Shift + clique abre o proprio arquivo
		name.addEventListener('click', event => send({ type: (event.ctrlKey || event.metaKey || event.shiftKey) ? 'openFile' : 'open', file: item.file }));
		row.appendChild(name);
		if (item.dir) { row.appendChild(el('span', 'dir', item.dir)); }
		if (item.status === 'added') { row.appendChild(el('span', 'tag new', L.tagNew)); }
		if (item.status === 'modified') { row.appendChild(el('span', 'tag mod', L.tagModified)); }
		if (item.status === 'deleted') { row.appendChild(el('span', 'tag gone', L.tagDeleted)); }
		if (item.sensitive) {
			const warn = el('span', 'tag warn', L.tagSensitive);
			warn.title = item.sensitive;
			row.appendChild(warn);
		}
		if (item.source === 'terminal') {
			const origin = el('span', 'tag term', item.approx ? 'TERMINAL ~' : 'TERMINAL');
			origin.title = item.approx ? L.terminalApprox : L.terminalExact;
			row.appendChild(origin);
		}
		const fileComment = item.comment;
		row.appendChild(button('icon comment' + (fileComment ? ' has' : ''), '\ud83d\udcac', L.commentFileTip, () => { editing = { file: item.file, key: fileKeyOf(item) }; draft = fileComment || ''; render(lastState); }));
		row.appendChild(el('span', 'spacer'));
		if (item.mtime) {
			const when = new Date(item.mtime);
			const sameDay = when.toDateString() === new Date().toDateString();
			const clock = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			const stamp = el('span', 'when', sameDay ? clock : when.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ' + clock);
			stamp.title = L.modifiedAt + ' ' + when.toLocaleString();
			row.appendChild(stamp);
		}
		row.appendChild(counts(item.added, item.removed));
		const actions = el('span', 'actions');
		actions.appendChild(button('icon keep', '\\u2713', L.keepTip, () => send({ type: 'keep', file: item.file })));
		actions.appendChild(button('icon undo', '\\u21b6', L.revertTip, () => send({ type: 'revert', file: item.file })));
		row.appendChild(actions);
		row.addEventListener('dblclick', () => send({ type: 'open', file: item.file }));
		row.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'agentecodeReviewRow', file: item.file }));
		list.appendChild(row);

		appendComment(list, item.file, fileKeyOf(item), item.comment, 40);

		if (item.expanded) {
			if (!item.hunks || !item.hunks.length) {
				list.appendChild(el('div', 'hunk none', L.noHunks));
			}
			for (const hunk of item.hunks || []) {
				const line = el('div', 'hunk');
				line.appendChild(el('span', 'at', fmt(L.atLine, hunk.line)));
				line.appendChild(button('icon comment' + (hunk.comment ? ' has' : ''), '\ud83d\udcac', L.commentTip, () => { editing = { file: item.file, key: hunk.commentKey }; draft = hunk.comment || ''; render(lastState); }));
				line.appendChild(el('span', 'spacer'));
				line.appendChild(counts(hunk.added, hunk.removed));
				const hunkActions = el('span', 'actions');
				hunkActions.appendChild(button('icon keep', '\\u2713', L.keepHunkTip, () => send({ type: 'keepHunk', file: item.file, key: hunk.key })));
				hunkActions.appendChild(button('icon undo', '\\u21b6', L.undoHunkTip, () => send({ type: 'undoHunk', file: item.file, key: hunk.key })));
				line.appendChild(hunkActions);
				line.addEventListener('click', () => send({ type: 'goto', file: item.file, line: hunk.line }));
				line.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'agentecodeReviewRow', file: item.file }));
				list.appendChild(line);
				appendComment(list, item.file, hunk.commentKey, hunk.comment, 58);
			}
		}
	}
	root.appendChild(list);
	if (state.comments) {
		const bar = el('div', 'commentbar');
		bar.appendChild(el('span', 'commentcount', fmt(state.comments === 1 ? L.commentsOne : L.commentsMany, state.comments)));
		bar.appendChild(el('span', 'spacer'));
		bar.appendChild(button('plain', L.commentsClear, L.commentsClearTip, () => send({ type: 'clearComments' })));
		bar.appendChild(button('primary', L.commentsSend, L.commentsSendTip, () => send({ type: 'sendComments' })));
		root.appendChild(bar);
	}
	root.appendChild(el('div', 'note', state.terminalNote || ''));
	if (hadFocus) {
		search.focus();
		search.setSelectionRange(caret[0], caret[1]);
	}
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
.tag.mod{background:rgba(56,139,253,.25);color:#79c0ff}
.filterbox{display:flex;align-items:center;gap:4px;padding:0 12px 6px}
.filter{flex:1;min-width:0;font:inherit;padding:3px 6px;border-radius:3px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);outline:none}
.filter:focus{border-color:var(--vscode-focusBorder)}
.clear{padding:0 6px;font-size:16px;line-height:1;color:var(--vscode-descriptionForeground)}
.clear:hover{color:var(--vscode-foreground)}
.tag.term{background:rgba(210,153,34,.25);color:#e3b341}
.when{color:var(--vscode-descriptionForeground);font-size:12px;white-space:nowrap;margin-right:10px}
.tag.warn{background:rgba(219,109,40,.28);color:#ffa657}
.spacer{flex:1}
.actions{display:none;gap:2px}
.row:hover .actions,.hunk:hover .actions{display:inline-flex}
.icon{width:20px;height:20px;border-radius:3px;font-size:13px;line-height:1}
.icon:hover{background:var(--vscode-toolbar-hoverBackground)}
.icon.keep{color:#56d364}.icon.undo{color:#ff7b72}
.icon.comment{opacity:.55}.hunk:hover .icon.comment,.icon.comment.has{opacity:1}
.hunk{padding-left:58px;font-size:12px;color:var(--vscode-descriptionForeground);cursor:pointer}
.hunk .at{font-family:var(--vscode-editor-font-family)}
.hunk.none{cursor:default}
.commenttext{margin:0 12px 4px 58px;padding:4px 8px;border-left:3px solid var(--vscode-focusBorder,#3794ff);background:var(--vscode-textBlockQuote-background,rgba(127,127,127,.1));font-size:12px;white-space:pre-wrap;cursor:pointer}
.commentbox{margin:2px 12px 6px 58px}
.commentarea{box-sizing:border-box;width:100%;resize:vertical;font:inherit;font-size:12px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-focusBorder));padding:4px 6px}
.commentbtns{display:flex;gap:6px;margin-top:4px}
.commentbtns button,.commentbar button{padding:2px 10px;border-radius:2px}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button.plain{border:1px solid var(--vscode-button-secondaryBackground,rgba(127,127,127,.4))}
.commentbar{position:sticky;bottom:0;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--vscode-sideBar-background,var(--vscode-editor-background));border-top:1px solid var(--vscode-panel-border,rgba(127,127,127,.35));z-index:2}
.note{padding:10px 12px 0;color:var(--vscode-descriptionForeground);font-size:11px}
`;

/** Textos do navegador, ja traduzidos, como JSON seguro para ir dentro de <script> (nunca chama t() no navegador). */
function labelsJson() {
	const labels = {
		stateAdded: t('New file'),
		stateModified: t('Modified file'),
		stateDeleted: t('Deleted file'),
		filesOne: t('{0} file'),
		filesMany: t('{0} files'),
		filesFiltered: t('{0} of {1} files'),
		filterPlaceholder: t('Filter files (name, folder, type)'),
		clearFilter: t('Clear the filter'),
		noMatch: t('No file matches the filter'),
		acceptShown: t('Accept {0} shown'),
		acceptShownTip: t('Marks only the files shown as reviewed'),
		discardShown: t('Discard {0} shown'),
		discardShownTip: t('Reverts only the files shown (asks for confirmation)'),
		acceptAll: t('Accept all'),
		acceptAllTip: t('Marks all files as reviewed'),
		discardAll: t('Discard all'),
		discardAllTip: t('Reverts all files to their previous state (asks for confirmation)'),
		compareWith: t('Compare with: {0}'),
		compareTip: t('Choose the comparison point'),
		switchChat: t('Switch conversation'),
		switchChatTip: t('Choose another agent conversation'),
		refresh: t('Refresh'),
		refreshTip: t('Recalculate now'),
		conversation: t('Conversation: {0}'),
		reviewedVisible: t('{0} already reviewed (visible)'),
		reviewedHidden: t('{0} already reviewed (hidden)'),
		hide: t('hide'),
		show: t('show'),
		showHunks: t('Show the hunks'),
		tagNew: t('NEW'),
		tagModified: t('MODIFIED'),
		tagDeleted: t('DELETED'),
		tagSensitive: t('SENSITIVE'),
		modifiedAt: t('Last modified:'),
		sortBy: t('Sort:'),
		sortTip: t('Change the order of the files (click to switch)'),
		sortNames: { path: t('path'), timeOldestFirst: t('time, oldest first'), timeNewestFirst: t('time, newest first') },
		nameTip: t('Click: view the difference · Ctrl+click: open the file'),
		terminalApprox: t('Changed outside the agent log (terminal or another tool). Approximate comparison, against the last commit before the conversation.'),
		terminalExact: t('Changed by a terminal command or another tool (outside the agent log).'),
		keepTip: t('Keep (mark as reviewed)'),
		revertTip: t('Revert this file'),
		noHunks: t('No pending hunks'),
		atLine: t('@line {0}'),
		keepHunkTip: t('Keep this hunk'),
		undoHunkTip: t('Undo this hunk'),
		commentTip: t('Comment on this hunk only: the lines changed here, starting at the line shown. Sent to Claude with the code and the line number.'),
		commentFileTip: t('Comment on the whole file: about the file as a whole, not a specific line. Works for new, modified and deleted files. Sent to Claude with the file path.'),
		commentPlaceholder: t('Write your comment (Ctrl+Enter to save)'),
		commentSave: t('Save'),
		commentSaveTip: t('Save the comment (Ctrl+Enter)'),
		commentCancel: t('Cancel'),
		commentRemove: t('Remove'),
		commentEditTip: t('Click to edit the comment'),
		commentsOne: t('{0} comment'),
		commentsMany: t('{0} comments'),
		commentsClear: t('Clear'),
		commentsClearTip: t('Deletes all the comments without sending them'),
		commentsSend: t('Send to Claude'),
		commentsSendTip: t('Pastes the comments, and the changes you discarded, in the Claude Code chat')
	};
	return JSON.stringify(labels).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * HTML completo da tela.
 * @param {{ nonce: string, cspSource: string }} options
 * @returns {string}
 */
function renderPanelHtml({ nonce, cspSource }) {
	return `<!doctype html><html lang="${getLanguage() === 'pt' ? 'pt-BR' : 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${STYLE}</style></head><body><div id="root"></div><script nonce="${nonce}">const L = ${labelsJson()};${CLIENT_SCRIPT}</script></body></html>`;
}

module.exports = { renderPanelHtml, CLIENT_SCRIPT };
