/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { planRewind, absolutizePlan, isInsideAny } = require('./checkpoints');
const { readIfExists, diffPlanAgainstDisk, applyChange } = require('./rewindPlan');
const { readHistoryEntries } = require('./review');
const { t } = require('./i18n');

const KEEP_UNDO_POINTS = 5;

const actionLabel = action => ({
	restore: t('goes back to the previous version'),
	recreate: t('is recreated (it was deleted later)'),
	delete: t('is deleted (it did not exist yet)'),
})[action];

/**
 * Pergunta quais arquivos restaurar, com opção de ver a diferença de cada um.
 * @returns {Promise<typeof changes | undefined>}
 */
function pickChanges(changes, roots, title) {
	return new Promise(resolve => {
		const pick = vscode.window.createQuickPick();
		pick.title = title;
		pick.placeholder = t('Uncheck what you do NOT want to touch. The conversation does not go back, and what was done by commands (Bash) is not undone.');
		pick.canSelectMany = true;
		pick.matchOnDescription = true;
		const items = changes.map(change => {
			const root = roots.find(r => isInsideAny(change.file, [r]));
			return {
				label: `$(file) ${root ? path.relative(root, change.file) : change.file}`,
				description: actionLabel(change.action),
				change,
				buttons: change.action === 'restore' ? [{ iconPath: new vscode.ThemeIcon('diff'), tooltip: t('View Difference') }] : [],
			};
		});
		pick.items = items;
		pick.selectedItems = items;
		pick.onDidTriggerItemButton(e => {
			const { change } = e.item;
			void vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(change.file), vscode.Uri.file(change.backup), t('{0} (current ↔ after rewind)', path.basename(change.file)));
		});
		let accepted = false;
		pick.onDidAccept(() => {
			accepted = true;
			resolve(pick.selectedItems.map(i => i.change));
			pick.hide();
		});
		pick.onDidHide(() => {
			pick.dispose();
			if (!accepted) {
				resolve(undefined);
			}
		});
		pick.show();
	});
}

/**
 * Guarda o estado atual dos arquivos que serao alterados, para poder desfazer a volta.
 * @param {vscode.ExtensionContext} context
 */
async function saveUndoPoint(context, label, changes) {
	const root = path.join(context.globalStorageUri.fsPath, 'rewind');
	const dir = path.join(root, new Date().toISOString().replace(/[:.]/g, '-'));
	await fs.promises.mkdir(path.join(dir, 'files'), { recursive: true });
	const items = [];
	for (const [index, change] of changes.entries()) {
		const current = await readIfExists(change.file);
		if (current !== undefined) {
			await fs.promises.writeFile(path.join(dir, 'files', String(index)), current);
		}
		items.push({ file: change.file, saved: current !== undefined ? String(index) : null });
	}
	await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ label, items }, null, 2));

	const all = (await fs.promises.readdir(root)).sort();
	for (const old of all.slice(0, Math.max(0, all.length - KEEP_UNDO_POINTS))) {
		await fs.promises.rm(path.join(root, old), { recursive: true, force: true });
	}
}

/**
 * Volta os arquivos de um projeto ao estado de antes de um prompt da sessao.
 * @param {vscode.ExtensionContext} context
 * @param {{ file: string, id: string, cwd?: string }} session
 * @param {{ messageId: string, prompt: string }} checkpoint
 */
async function rewindToCheckpoint(context, session, checkpoint) {
	const entries = await readHistoryEntries(session.file);
	const rawPlan = planRewind(entries, checkpoint.messageId);
	if (!rawPlan?.length) {
		void vscode.window.showInformationMessage(t('This point has no tracked files to rewind.'));
		return;
	}

	const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
	if (!roots.length && session.cwd) {
		roots.push(session.cwd);
	}
	const plan = absolutizePlan(rawPlan, session.cwd ?? roots[0]);
	const inside = plan.filter(p => isInsideAny(p.file, roots));
	const outside = plan.length - inside.length;

	const { changes, missingBackups } = await diffPlanAgainstDisk(inside, session.id);
	if (!changes.length) {
		void vscode.window.showInformationMessage(t('The files are already as they were before this response. Nothing to rewind.'));
		return;
	}

	const shortPrompt = checkpoint.prompt.length > 60 ? `${checkpoint.prompt.slice(0, 60)}…` : checkpoint.prompt;
	const chosen = await pickChanges(changes, roots, t('Rewind files to before: {0}', shortPrompt));
	if (!chosen?.length) {
		return;
	}

	// isInsideAny com a raiz igual ao arquivo vale como comparacao de caminhos (ignora maiusculas no Windows)
	const dirty = chosen.filter(c => vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && isInsideAny(d.uri.fsPath, [c.file])));
	if (dirty.length) {
		void vscode.window.showWarningMessage(t('Save or discard the changes open in the editor before rewinding: {0}.', dirty.map(d => path.basename(d.file)).join(', ')));
		return;
	}

	const notes = [];
	if (outside) {
		notes.push(t('{0} file(s) outside this folder were ignored.', outside));
	}
	if (missingBackups) {
		notes.push(t('{0} file(s) without a stored copy were ignored.', missingBackups));
	}
	const rewindLabel = t('Rewind Files');
	const confirm = await vscode.window.showWarningMessage(
		t('Rewind {0} file(s) to before this response?', chosen.length),
		{ modal: true, detail: `${notes.join(' ')}${notes.length ? '\n\n' : ''}${t('The current state is kept and you can undo it with "AgenteCode: Undo Last File Rewind".')}` },
		rewindLabel
	);
	if (confirm !== rewindLabel) {
		return;
	}

	await saveUndoPoint(context, shortPrompt, chosen);
	let failed = 0;
	for (const change of chosen) {
		try {
			await applyChange(change);
		} catch (error) {
			failed++;
			console.error(`AgenteCode: falha ao voltar ${change.file}`, error);
		}
	}

	const done = chosen.length - failed;
	const undo = t('Undo');
	const choice = await vscode.window.showInformationMessage(
		failed ? t('{0} file(s) rewound; {1} failed (see the developer console).', done, failed) : t('{0} file(s) rewound to before this response.', done),
		undo
	);
	if (choice === undo) {
		await undoLastRewind(context);
	}
}

/** @param {vscode.ExtensionContext} context */
async function undoLastRewind(context) {
	const root = path.join(context.globalStorageUri.fsPath, 'rewind');
	let names;
	try {
		names = (await fs.promises.readdir(root)).sort();
	} catch {
		names = [];
	}
	const latest = names[names.length - 1];
	if (!latest) {
		void vscode.window.showInformationMessage(t('There is no file rewind to undo.'));
		return;
	}

	const dir = path.join(root, latest);
	const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8'));
	let failed = 0;
	for (const item of manifest.items) {
		try {
			if (item.saved === null) {
				await fs.promises.rm(item.file, { force: true });
			} else {
				await fs.promises.mkdir(path.dirname(item.file), { recursive: true });
				await fs.promises.copyFile(path.join(dir, 'files', item.saved), item.file);
			}
		} catch (error) {
			failed++;
			console.error(`AgenteCode: falha ao desfazer ${item.file}`, error);
		}
	}
	if (!failed) {
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
	void vscode.window.showInformationMessage(failed
		? t('Undone with {0} failure(s) (see the developer console).', failed)
		: t('Rewind undone: {0} file(s) are back as before.', manifest.items.length));
}

module.exports = { rewindToCheckpoint, undoLastRewind, saveUndoPoint };
