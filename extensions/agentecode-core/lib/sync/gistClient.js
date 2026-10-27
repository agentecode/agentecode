/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const config = require('./config');
const { t } = require('../i18n');

class GistError extends Error {
	constructor(message, code, status) {
		super(message);
		this.name = 'GistError';
		this.code = code;
		this.status = status;
	}
}

class TokenRevokedError extends GistError {
	constructor(message = t('Access token revoked or invalid (401).')) {
		super(message, 'TOKEN_REVOKED', 401);
		this.name = 'TokenRevokedError';
	}
}

class RateLimitError extends GistError {
	constructor(message, resetSeconds, retryAfter) {
		super(message, 'RATE_LIMIT_EXCEEDED', 429);
		this.name = 'RateLimitError';
		this.resetSeconds = resetSeconds;
		this.retryAfter = retryAfter;
	}
}

class GistNotFoundError extends GistError {
	constructor(message = t('Gist not found on GitHub (404).')) {
		super(message, 'NOT_FOUND', 404);
		this.name = 'GistNotFoundError';
	}
}

class GistValidationError extends GistError {
	constructor(message = t('Invalid data for the Gist (422).')) {
		super(message, 'VALIDATION_FAILED', 422);
		this.name = 'GistValidationError';
	}
}

class GistForbiddenError extends GistError {
	constructor(message = t('Insufficient permission to access or create Gists on GitHub (403).'), status = 403) {
		super(message, 'FORBIDDEN', status);
		this.name = 'GistForbiddenError';
	}
}

class GistNetworkError extends GistError {
	constructor(message = t('Connection error with the GitHub Gists service.')) {
		super(message, 'NETWORK_ERROR', 0);
		this.name = 'GistNetworkError';
	}
}

/**
 * Combina timeout de 30s com um signal de cancelamento externo (E5.2).
 * @param {number} timeoutMs
 * @param {AbortSignal} [externalSignal]
 * @returns {AbortSignal}
 */
function combineSignals(timeoutMs = 30000, externalSignal = null) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!externalSignal) {
		return timeoutSignal;
	}
	if (typeof AbortSignal.any === 'function') {
		return AbortSignal.any([timeoutSignal, externalSignal]);
	}
	const controller = new AbortController();
	const onAbort = function () {
		controller.abort(this.reason);
	};
	timeoutSignal.addEventListener('abort', onAbort, { once: true });
	externalSignal.addEventListener('abort', onAbort, { once: true });
	return controller.signal;
}

/**
 * Cria os cabecalhos padrao para requisicoes a API de Gists do GitHub.
 * @param {string} token
 * @param {Record<string, string>} [extra]
 */
function defaultHeaders(token, extra = {}) {
	return {
		'Authorization': `Bearer ${token}`,
		'Accept': 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'AgenteCode-Sync',
		...extra
	};
}

/**
 * Avalia a resposta HTTP e lanca o erro tipado correspondente caso nao seja sucesso.
 * @param {Response} response
 */
async function handleResponseErrors(response) {
	if (response.ok || response.status === 304) {
		return;
	}

	if (response.status === 401) {
		throw new TokenRevokedError();
	}

	if (response.status === 404) {
		throw new GistNotFoundError();
	}

	if (response.status === 422) {
		const text = await response.text().catch(() => '');
		throw new GistValidationError(t('Gist validation error: {0}', text));
	}

	if (response.status === 429) {
		const retryAfter = Number(response.headers.get('retry-after')) || 0;
		const resetHeader = Number(response.headers.get('x-ratelimit-reset')) || 0;
		const resetSeconds = resetHeader ? Math.max(0, resetHeader - Math.floor(Date.now() / 1000)) : 0;
		throw new RateLimitError(
			t('GitHub request limit reached. Try again in a few minutes.'),
			resetSeconds,
			retryAfter
		);
	}

	if (response.status === 403) {
		const remaining = response.headers.get('x-ratelimit-remaining');
		const retryAfter = Number(response.headers.get('retry-after')) || 0;
		const text = await response.text().catch(() => '');
		const isRateLimit = remaining === '0' || retryAfter > 0 || /rate\s*limit|abuse/i.test(text);

		if (isRateLimit) {
			const resetHeader = Number(response.headers.get('x-ratelimit-reset')) || 0;
			const resetSeconds = resetHeader ? Math.max(0, resetHeader - Math.floor(Date.now() / 1000)) : 0;
			throw new RateLimitError(
				t('GitHub request limit reached. Try again in a few minutes.'),
				resetSeconds,
				retryAfter
			);
		}

		throw new GistForbiddenError(
			t('Insufficient permission to access GitHub Gists: {0}', text || t('Access denied')),
			response.status
		);
	}

	const errorText = await response.text().catch(() => '');
	throw new GistError(t('GitHub returned HTTP error {0}: {1}', response.status, errorText), 'HTTP_ERROR', response.status);
}

/**
 * Procura um Gist existente da conta que contenha a marca de sincronizacao do AgenteCode.
 * Pagina a lista de gists caso haja mais de 100.
 *
 * @param {string} token
 * @param {object} [options]
 * @param {string} [options.marker]
 * @param {string} [options.apiBaseUrl]
 * @param {typeof fetch} [options.fetchFn]
 * @returns {Promise<any | null>} Objeto do Gist encontrado ou null
 */
async function findSyncGist(token, options = {}) {
	const marker = options.marker || config.GIST_MARKER;
	const apiBaseUrl = options.apiBaseUrl || config.getGitHubApi();
	const fetchFn = options.fetchFn || globalThis.fetch;

	let page = 1;
	while (page <= 10) {
		const url = `${apiBaseUrl}/gists?per_page=100&page=${page}`;
		let response;
		try {
			response = await fetchFn(url, {
				method: 'GET',
				headers: defaultHeaders(token),
				signal: combineSignals(30000, options.signal)
			});
		} catch (err) {
			throw new GistNetworkError(err.message);
		}

		await handleResponseErrors(response);

		const gists = await response.json();
		if (!Array.isArray(gists) || gists.length === 0) {
			break;
		}

		for (const gist of gists) {
			if (gist && gist.description && gist.description.includes(marker)) {
				return gist;
			}
		}

		if (gists.length < 100) {
			break;
		}
		page++;
	}

	return null;
}

/**
 * Cria um novo Gist secreto no GitHub.
 * @param {string} token
 * @param {object} params
 * @param {string} [params.description]
 * @param {boolean} [params.isPublic] Padrao: false (secreto)
 * @param {Record<string, { content: string }>} params.files
 * @param {object} [options]
 * @param {string} [options.apiBaseUrl]
 * @param {typeof fetch} [options.fetchFn]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<any>}
 */
async function createGist(token, { description, isPublic = false, files }, options = {}) {
	const apiBaseUrl = options.apiBaseUrl || config.getGitHubApi();
	const fetchFn = options.fetchFn || globalThis.fetch;

	const desc = description || config.GIST_DESCRIPTION;
	const body = JSON.stringify({
		description: desc,
		public: isPublic,
		files
	});

	let response;
	try {
		response = await fetchFn(`${apiBaseUrl}/gists`, {
			method: 'POST',
			headers: defaultHeaders(token, { 'Content-Type': 'application/json' }),
			body,
			signal: combineSignals(30000, options.signal)
		});
	} catch (err) {
		throw new GistNetworkError(err.message);
	}

	await handleResponseErrors(response);
	return response.json();
}

/**
 * Obtem os detalhes de um Gist pelo seu ID.
 * Suporta ETag (retorna { notModified: true } em caso de HTTP 304).
 * Baixa automaticamente o conteudo completo via raw_url caso algum arquivo venha truncated.
 * Nunca envia o token para o raw_url e lanca erro tipado caso o download falhe.
 *
 * @param {string} token
 * @param {string} gistId
 * @param {object} [options]
 * @param {string} [options.etag]
 * @param {string} [options.apiBaseUrl]
 * @param {typeof fetch} [options.fetchFn]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ notModified: boolean, gist?: any, etag?: string }>}
 */
async function getGist(token, gistId, options = {}) {
	const apiBaseUrl = options.apiBaseUrl || config.getGitHubApi();
	const fetchFn = options.fetchFn || globalThis.fetch;

	const headers = defaultHeaders(token);
	if (options.etag) {
		headers['If-None-Match'] = options.etag;
	}

	let response;
	try {
		response = await fetchFn(`${apiBaseUrl}/gists/${gistId}`, {
			method: 'GET',
			headers,
			signal: combineSignals(30000, options.signal)
		});
	} catch (err) {
		throw new GistNetworkError(err.message);
	}

	if (response.status === 304) {
		return { notModified: true, etag: options.etag };
	}

	await handleResponseErrors(response);

	const gist = await response.json();
	const etag = response.headers.get('etag') || undefined;

	// Trata arquivos truncados baixando o raw_url (E3)
	if (gist && gist.files) {
		for (const [name, fileObj] of Object.entries(gist.files)) {
			if (fileObj && fileObj.truncated) {
				if (fileObj.raw_url) {
					try {
						// NUNCA enviar token para o raw_url (outro dominio; gists secretos tem hash que dispensa autenticacao)
						const rawHeaders = { 'User-Agent': 'AgenteCode-Sync' };
						const rawRes = await fetchFn(fileObj.raw_url, {
							method: 'GET',
							headers: rawHeaders,
							signal: combineSignals(30000, options.signal)
						});
						if (rawRes.ok) {
							fileObj.content = await rawRes.text();
							fileObj.truncated = false;
						} else {
							throw new GistError(
								t("Failed to retrieve the full content of the truncated file '{0}': HTTP {1}", name, rawRes.status),
								'TRUNCATED',
								rawRes.status
							);
						}
					} catch (err) {
						if (err instanceof GistError && err.code === 'TRUNCATED') {
							throw err;
						}
						throw new GistError(
							t("Network failure while downloading the truncated file '{0}': {1}", name, err.message),
							'TRUNCATED',
							0
						);
					}
				}

				if (fileObj.truncated) {
					throw new GistError(
						t("The file '{0}' was truncated by the GitHub API and the full content could not be retrieved.", name),
						'TRUNCATED',
						0
					);
				}
			}
		}
	}

	return { notModified: false, gist, etag };
}

/**
 * Atualiza um Gist existente.
 * Arquivos podem ser atualizados ({ content: string }) ou apagados ({ [nome]: null }).
 *
 * @param {string} token
 * @param {string} gistId
 * @param {object} params
 * @param {string} [params.description]
 * @param {Record<string, { content: string } | null>} params.files
 * @param {object} [options]
 * @param {string} [options.apiBaseUrl]
 * @param {typeof fetch} [options.fetchFn]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<any>}
 */
async function updateGist(token, gistId, { description, files }, options = {}) {
	const apiBaseUrl = options.apiBaseUrl || config.getGitHubApi();
	const fetchFn = options.fetchFn || globalThis.fetch;

	const payload = { files };
	if (description !== undefined) {
		payload.description = description;
	}

	let response;
	try {
		response = await fetchFn(`${apiBaseUrl}/gists/${gistId}`, {
			method: 'PATCH',
			headers: defaultHeaders(token, { 'Content-Type': 'application/json' }),
			body: JSON.stringify(payload),
			signal: combineSignals(30000, options.signal)
		});
	} catch (err) {
		throw new GistNetworkError(err.message);
	}

	await handleResponseErrors(response);
	return response.json();
}

/**
 * Verifica se o Gist pertence ao usuario conectado (E2).
 * @param {any} gist
 * @param {string} currentLogin
 * @returns {boolean}
 */
function isGistOwner(gist, currentLogin) {
	if (!gist || !currentLogin || typeof currentLogin !== 'string') {
		return false;
	}
	const ownerLogin = gist.owner && gist.owner.login;
	if (!ownerLogin || typeof ownerLogin !== 'string') {
		return false;
	}
	return ownerLogin.trim().toLowerCase() === currentLogin.trim().toLowerCase();
}

module.exports = {
	GistError,
	TokenRevokedError,
	RateLimitError,
	GistNotFoundError,
	GistValidationError,
	GistForbiddenError,
	GistNetworkError,
	findSyncGist,
	createGist,
	getGist,
	updateGist,
	isGistOwner,
	combineSignals
};
