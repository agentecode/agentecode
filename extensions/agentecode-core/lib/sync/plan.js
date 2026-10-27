/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { sha256 } = require('./snapshot');
const config = require('./config');
const { t } = require('../i18n');

/**
 * Calcula o hash composto do conteudo remoto (ignora manifesto e README).
 *
 * @param {Record<string, string>} remoteFiles Arquivos do Gist
 * @param {any} [remoteManifest] Manifesto remoto agentecode-sync.json
 * @returns {string}
 */
function computeRemoteCompositeHash(remoteFiles, remoteManifest) {
	if (remoteManifest && remoteManifest.compositeHash) {
		return remoteManifest.compositeHash;
	}
	const keys = Object.keys(remoteFiles || {})
		.filter(f => f !== config.MANIFEST_FILE && f !== config.README_FILE)
		.sort();
	return sha256(keys.map(f => `${f}:${sha256(remoteFiles[f])}\n`).join(''));
}

/**
 * Diz se o remoto mudou desde a base. Compara o conteudo (hash composto) quando a base o tem;
 * so recorre a data de atualizacao do Gist na falta dele, pois a data muda mesmo com conteudo igual.
 *
 * @param {any} base Ultimo estado de sincronizacao salvo localmente
 * @param {string} remoteCompositeHash Hash composto do remoto
 * @param {string} [remoteUpdatedAt] updated_at atual do Gist
 * @returns {boolean}
 */
function hasRemoteChanged(base, remoteCompositeHash, remoteUpdatedAt) {
	if (base && base.manifestHash) {
		return remoteCompositeHash !== base.manifestHash;
	}
	if (base && base.remoteUpdatedAt && remoteUpdatedAt) {
		return base.remoteUpdatedAt !== remoteUpdatedAt;
	}
	return false;
}

/**
 * Cria o plano de sincronizacao comparando o estado local, remoto e a base (ultima sincronizacao).
 * Implementa a decisao de 3 vias da secao 6.3 do plano.
 *
 * @param {object} params
 * @param {object} params.localSnapshot Retorno de snapshot.createLocalSnapshot
 * @param {Record<string, string> | null} params.remoteFiles Arquivos do Gist (ou null se o Gist nao existir)
 * @param {any} [params.remoteManifest] Manifesto remoto agentecode-sync.json
 * @param {string} [params.remoteUpdatedAt] Timestamp ISO updated_at do Gist no GitHub
 * @param {object | null} [params.base] Ultimo estado de sincronizacao salvo localmente
 * @param {string} [params.base.localHash] Hash composto do local na ultima sincronizacao
 * @param {string} [params.base.manifestHash] Hash composto do remoto na ultima sincronizacao
 * @param {string} [params.base.remoteUpdatedAt] updated_at remoto na ultima sincronizacao
 * @param {Record<string, string>} [params.base.files] Mapa de file -> sha256 da base
 * @param {any} [params.gist] Objeto completo do Gist (para checagem de dono)
 * @param {string} [params.currentLogin] Login do usuario conectado
 * @param {boolean} [params.isConfirmedThirdParty] Se o usuario ja confirmou explicitamente o download de terceiro
 * @returns {object} Plano com decisao, diferencas de arquivos e extensoes
 */
function createSyncPlan({
	localSnapshot,
	remoteFiles,
	remoteManifest = null,
	remoteUpdatedAt = null,
	base = null,
	gist = null,
	currentLogin = null,
	isConfirmedThirdParty = false
}) {
	const localFiles = localSnapshot.files || {};
	const localHashes = localSnapshot.fileHashes || {};

	// Checagem de dono do Gist (E2)
	let isThirdParty = false;
	let warning = null;
	const remoteOwner = (gist && gist.owner && gist.owner.login) || (remoteManifest && remoteManifest.machine && remoteManifest.machine.owner);
	if (remoteOwner && currentLogin) {
		if (remoteOwner.trim().toLowerCase() !== currentLogin.trim().toLowerCase()) {
			isThirdParty = true;
			warning = t('This Gist is not yours. Third-party settings can run programs and install extensions.');
		}
	}

	// 1. Caso sem Gist remoto (primeiro envio absoluto)
	if (!remoteFiles) {
		const filesToUpload = Object.keys(localFiles).filter(f => f !== config.MANIFEST_FILE);
		return {
			action: 'initialUpload',
			hasChanges: filesToUpload.length > 0,
			localChanged: true,
			remoteChanged: false,
			filesToUpload,
			fileDiffs: [],
			extensionsDiff: { toInstall: [], alreadyInstalled: localSnapshot.extensions, localOnly: [] },
			summary: t('First upload of settings to GitHub.'),
			isThirdParty: false,
			canAutoSync: true,
			warning: null
		};
	}

	// 2. Calcula diferencas detalhadas de arquivos (Local x Remoto)
	const allFileNames = new Set([
		...Object.keys(localFiles),
		...Object.keys(remoteFiles)
	]);
	allFileNames.delete(config.MANIFEST_FILE);
	allFileNames.delete(config.README_FILE);

	const fileDiffs = [];
	for (const fileName of Array.from(allFileNames).sort()) {
		const inLocal = Object.prototype.hasOwnProperty.call(localFiles, fileName);
		const inRemote = Object.prototype.hasOwnProperty.call(remoteFiles, fileName);

		const localContent = inLocal ? localFiles[fileName] : null;
		const remoteContent = inRemote ? remoteFiles[fileName] : null;

		const localSha = inLocal ? (localHashes[fileName] || sha256(localContent)) : null;
		const remoteSha = inRemote ? sha256(remoteContent) : null;

		let status;
		if (inLocal && inRemote) {
			status = localSha === remoteSha ? 'identical' : 'modified';
		} else if (inLocal) {
			status = 'localOnly';
		} else {
			status = 'remoteOnly';
		}

		fileDiffs.push({
			file: fileName,
			status,
			localContent,
			remoteContent,
			localSha,
			remoteSha
		});
	}

	// 3. Diferencas de extensoes
	const localExtensions = new Set(localSnapshot.extensions || []);
	let remoteExtensionsList = [];
	if (remoteFiles[config.EXTENSIONS_FILE]) {
		try {
			const parsed = JSON.parse(remoteFiles[config.EXTENSIONS_FILE]);
			if (Array.isArray(parsed.extensions)) {
				remoteExtensionsList = parsed.extensions.map(id => id.toLowerCase().trim()).filter(Boolean);
			}
		} catch {
			remoteExtensionsList = [];
		}
	}
	const remoteExtensions = new Set(remoteExtensionsList);

	const toInstall = remoteExtensionsList.filter(id => !localExtensions.has(id));
	const alreadyInstalled = remoteExtensionsList.filter(id => localExtensions.has(id));
	const localOnlyExt = (localSnapshot.extensions || []).filter(id => !remoteExtensions.has(id));

	const extensionsDiff = {
		toInstall,
		alreadyInstalled,
		localOnly: localOnlyExt
	};

	// 4. Caso sem base ou base invalida (E5.5: base sem localHash nem files deve ser tratada como sem base)
	const hasValidBase = Boolean(
		base &&
		typeof base === 'object' &&
		(
			(typeof base.localHash === 'string' && base.localHash.length > 0) ||
			(base.files && typeof base.files === 'object' && Object.keys(base.files).length > 0)
		)
	);

	if (!hasValidBase) {
		const hasRemoteItems = fileDiffs.some(d => d.status !== 'identical') || toInstall.length > 0;
		return {
			action: 'downloadFirst',
			hasChanges: hasRemoteItems,
			localChanged: false,
			remoteChanged: true,
			fileDiffs,
			extensionsDiff,
			filesToUpload: [],
			summary: t('Existing Gist found. Downloading first is recommended.'),
			isThirdParty,
			canAutoSync: !isThirdParty,
			requiresThirdPartyConfirmation: isThirdParty && !isConfirmedThirdParty,
			warning
		};
	}

	// 5. Decisao de 3 vias com base existente
	const localCompositeHash = localSnapshot.compositeHash;
	// E5.5: hash de fallback nao deve incluir agentecode-sync.json e LEIA-ME.md
	const remoteCompositeHash = computeRemoteCompositeHash(remoteFiles, remoteManifest);

	// Local mudou desde a base?
	let localChanged = false;
	if (base.localHash) {
		localChanged = localCompositeHash !== base.localHash;
	} else if (base.files) {
		for (const [f, h] of Object.entries(localHashes)) {
			if (base.files[f] !== h) {
				localChanged = true;
				break;
			}
		}
	}

	// Remoto mudou desde a base?
	const remoteChanged = hasRemoteChanged(base, remoteCompositeHash, remoteUpdatedAt);

	// Arquivos que mudaram localmente em relacao ao remoto ou base
	const filesToUpload = fileDiffs
		.filter(d => d.status === 'modified' || d.status === 'localOnly')
		.map(d => d.file);

	let action;
	let summary;

	if (!localChanged && !remoteChanged) {
		action = 'nothing';
		summary = t('No changes detected (everything is in sync).');
	} else if (localChanged && !remoteChanged) {
		action = 'upload';
		summary = t('{0} file(s) modified locally to upload.', filesToUpload.length);
	} else if (!localChanged && remoteChanged) {
		action = 'notifyDownload';
		summary = t('There are newer settings on GitHub ready to download.');
	} else {
		action = 'conflict';
		summary = t('Settings changed on this computer and on GitHub as well (conflict).');
	}

	return {
		action,
		hasChanges: action !== 'nothing',
		localChanged,
		remoteChanged,
		fileDiffs,
		extensionsDiff,
		filesToUpload,
		summary,
		isThirdParty,
		canAutoSync: !isThirdParty,
		requiresThirdPartyConfirmation: isThirdParty && !isConfirmedThirdParty,
		warning
	};
}

/**
 * Decide o que fazer ao tentar enviar, dado o plano calculado contra o Gist atual.
 * Nunca sobrescreve o remoto sem que ele tenha sido comparado antes.
 *
 * @param {{action: string, hasChanges: boolean}} syncPlan
 * @param {{auto: boolean}} options
 * @returns {'upload'|'skip'|'notifyDownload'|'askConflict'|'blocked'}
 */
function decideUpload(syncPlan, { auto }) {
	switch (syncPlan.action) {
		case 'initialUpload':
		case 'upload':
			return 'upload';
		case 'nothing':
			return 'skip';
		case 'notifyDownload':
			return 'notifyDownload';
		case 'downloadFirst':
			if (!syncPlan.hasChanges) {
				return 'upload';
			}
			return auto ? 'blocked' : 'askConflict';
		default:
			return auto ? 'blocked' : 'askConflict';
	}
}

module.exports = {
	computeRemoteCompositeHash,
	hasRemoteChanged,
	decideUpload,
	createSyncPlan
};
