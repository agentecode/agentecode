/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseVersion, compareVersions, notesBetween, sectionFor } = require('./releaseNotes');
const { t } = require('./i18n');

const LAST_SEEN_KEY = 'agentecode.releaseNotes.lastSeen';
const SHOW_DELAY_MS = 4000;

/** Versao instalada, lida do nome do produto ("Agente Code IDE v1.0.0"); undefined em build de desenvolvimento. */
function installedVersion() {
	return parseVersion(vscode.env.appName)?.join('.');
}

/** @param {vscode.ExtensionContext} context */
function readNotesFile(context) {
	return fs.promises.readFile(path.join(context.extensionPath, 'RELEASE_NOTES.md'), 'utf8');
}

/**
 * Abre as notas na visualizacao de Markdown.
 * @param {vscode.ExtensionContext} context
 * @param {string} text secoes em Markdown
 * @param {string} label versao ou texto do titulo
 */
async function openNotes(context, text, label) {
	await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
	const file = path.join(context.globalStorageUri.fsPath, 'novidades.md');
	await fs.promises.writeFile(file, `${t('# What\'s new in AgenteCode {0}', label).trimEnd()}\n\n${text}\n`, 'utf8');
	await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
}

/**
 * Comando manual: mostra as notas da versao instalada (ou o arquivo todo, em build sem versao).
 * @param {vscode.ExtensionContext} context
 */
async function showCurrentNotes(context) {
	const markdown = await readNotesFile(context);
	const version = installedVersion();
	const text = version ? sectionFor(markdown, version) : markdown;
	if (!text) {
		void vscode.window.showInformationMessage(t('There are no written notes for version {0}.', version));
		return;
	}
	await openNotes(context, text, version ? `v${version}` : '');
}

/**
 * Na primeira abertura depois de a versao subir, mostra as novidades (de todas as versoes puladas).
 * Na primeira instalacao so registra a versao, sem abrir nada.
 * @param {vscode.ExtensionContext} context
 * @param {vscode.LogOutputChannel} log
 */
async function showNotesAfterUpdate(context, log) {
	if (!vscode.workspace.getConfiguration('agentecode.releaseNotes').get('show', true)) {
		return;
	}
	const version = installedVersion();
	if (!version) {
		return;
	}
	const lastSeen = context.globalState.get(LAST_SEEN_KEY);
	const previous = parseVersion(lastSeen);
	await context.globalState.update(LAST_SEEN_KEY, version);

	if (!previous || compareVersions(parseVersion(version), previous) <= 0) {
		log.info(`Notas da versão: nada a mostrar (instalada ${version}, vista antes ${lastSeen ?? 'nenhuma'}).`);
		return;
	}
	const text = notesBetween(await readNotesFile(context), lastSeen, version);
	if (!text) {
		log.info(`Notas da versão: nenhuma seção escrita entre ${lastSeen} e ${version}.`);
		return;
	}
	await openNotes(context, text, `v${version}`);
	log.info(`Notas da versão: exibidas (de ${lastSeen} para ${version}).`);
}

/** @param {vscode.ExtensionContext} context */
function registerReleaseNotes(context) {
	const log = vscode.window.createOutputChannel('AgenteCode', { log: true });
	context.subscriptions.push(
		log,
		vscode.commands.registerCommand('agentecode.showReleaseNotes', () => showCurrentNotes(context)),
	);
	// O nucleo so registra este comando quando o produto tem `releaseNotesUrl` (o AgenteCode nao tem), mas os
	// avisos de atualizacao da IDE o chamam. Aponta para as nossas notas; se o nucleo passar a registra-lo, deixa o dele.
	try {
		context.subscriptions.push(vscode.commands.registerCommand('update.showCurrentReleaseNotes', () => showCurrentNotes(context)));
	} catch {
		log.info('update.showCurrentReleaseNotes já está registrado pelo núcleo; mantendo o dele.');
	}
	const timer = setTimeout(() => {
		showNotesAfterUpdate(context, log).catch(error => log.error(`Notas da versão: falha (${error.message})`));
	}, SHOW_DELAY_MS);
	context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

module.exports = { registerReleaseNotes };
