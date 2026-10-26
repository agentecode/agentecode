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

const KEEP_UNDO_POINTS = 5;

const ACTION_LABEL = {
	restore: 'volta à versão anterior',
	recreate: 'é recriado (foi apagado depois)',
	delete: 'é excluído (não existia ainda)',
};

/**
 * Pergunta quais arquivos restaurar, com opção de ver a diferença de cada um.
 * @returns {Promise<typeof changes | undefined>}
 */
function pickChanges(changes, roots, title) {
	return new Promise(resolve => {
		const pick = vscode.window.createQuickPick();
		pick.title = title;
		pick.placeholder = 'Desmarque o que NÃO quer mexer. A conversa não volta, e o que foi feito por comandos (Bash) não é desfeito.';
		pick.canSelectMany = true;
		pick.matchOnDescription = true;
		const items = changes.map(change => {
			const root = roots.find(r => isInsideAny(change.file, [r]));
			return {
				label: `$(file) ${root ? path.relative(root, change.file) : change.file}`,
				description: ACTION_LABEL[change.action],
				change,
				buttons: change.action === 'restore' ? [{ iconPath: new vscode.ThemeIcon('diff'), tooltip: 'Ver diferença' }] : [],
			};
		});
		pick.items = items;
		pick.selectedItems = items;
		pick.onDidTriggerItemButton(e => {
			const { change } = e.item;
			void vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(change.file), vscode.Uri.file(change.backup), `${path.basename(change.file)} (atual ↔ após voltar)`);
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
		void vscode.window.showInformationMessage('Este ponto não tem arquivos rastreados para voltar.');
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
		void vscode.window.showInformationMessage('Os arquivos já estão como eram antes desta resposta. Nada para voltar.');
		return;
	}

	const shortPrompt = checkpoint.prompt.length > 60 ? `${checkpoint.prompt.slice(0, 60)}…` : checkpoint.prompt;
	const chosen = await pickChanges(changes, roots, `Voltar arquivos para antes de: ${shortPrompt}`);
	if (!chosen?.length) {
		return;
	}

	// isInsideAny com a raiz igual ao arquivo vale como comparacao de caminhos (ignora maiusculas no Windows)
	const dirty = chosen.filter(c => vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && isInsideAny(d.uri.fsPath, [c.file])));
	if (dirty.length) {
		void vscode.window.showWarningMessage(`Salve ou descarte as alterações abertas no editor antes de voltar: ${dirty.map(d => path.basename(d.file)).join(', ')}.`);
		return;
	}

	const notes = [];
	if (outside) {
		notes.push(`${outside} arquivo(s) fora desta pasta foram ignorados.`);
	}
	if (missingBackups) {
		notes.push(`${missingBackups} arquivo(s) sem cópia guardada foram ignorados.`);
	}
	const confirm = await vscode.window.showWarningMessage(
		`Voltar ${chosen.length} arquivo(s) para antes desta resposta?`,
		{ modal: true, detail: `${notes.join(' ')}${notes.length ? '\n\n' : ''}O estado atual fica guardado e dá para desfazer em "AgenteCode: Desfazer a última volta de arquivos".` },
		'Voltar arquivos'
	);
	if (confirm !== 'Voltar arquivos') {
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
	const undo = 'Desfazer';
	const choice = await vscode.window.showInformationMessage(
		failed ? `${done} arquivo(s) voltaram; ${failed} falharam (veja o console do desenvolvedor).` : `${done} arquivo(s) voltaram para antes desta resposta.`,
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
		void vscode.window.showInformationMessage('Não há nenhuma volta de arquivos para desfazer.');
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
		? `Desfeito com ${failed} falha(s) (veja o console do desenvolvedor).`
		: `Volta desfeita: ${manifest.items.length} arquivo(s) estão como antes.`);
}

module.exports = { rewindToCheckpoint, undoLastRewind, saveUndoPoint };
