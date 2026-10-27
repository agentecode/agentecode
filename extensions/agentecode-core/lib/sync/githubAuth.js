/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const config = require('./config');
const { t } = require('../i18n');

class AuthError extends Error {
	constructor(message, code) {
		super(message);
		this.name = 'AuthError';
		this.code = code;
	}
}

class TokenExpiredError extends AuthError {
	constructor(message = t('The authorization code expired. Please try again.')) {
		super(message, 'EXPIRED_TOKEN');
		this.name = 'TokenExpiredError';
	}
}

class AccessDeniedError extends AuthError {
	constructor(message = t('The authorization was cancelled in the browser.')) {
		super(message, 'ACCESS_DENIED');
		this.name = 'AccessDeniedError';
	}
}

class NetworkError extends AuthError {
	constructor(message = t('Could not connect to GitHub. Check your connection.')) {
		super(message, 'NETWORK_ERROR');
		this.name = 'NetworkError';
	}
}

/**
 * Combina timeout com signal de cancelamento externo (E5.2).
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
 * Inicia o fluxo Device Flow do GitHub.
 * @param {object} options
 * @param {string} [options.clientId]
 * @param {string} [options.scope] Padrao: 'gist'
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchFn]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ device_code: string, user_code: string, verification_uri: string, expires_in: number, interval: number }>}
 */
async function startDeviceFlow(options = {}) {
	const clientId = options.clientId || config.getClientId();
	const baseUrl = options.baseUrl || config.getGitHubBase();
	const scope = options.scope || 'gist';
	const fetchFn = options.fetchFn || globalThis.fetch;

	const url = `${baseUrl}/login/device/code`;
	let response;
	try {
		response = await fetchFn(url, {
			method: 'POST',
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json',
				'User-Agent': 'AgenteCode-Sync'
			},
			body: JSON.stringify({
				client_id: clientId,
				scope
			}),
			signal: combineSignals(30000, options.signal)
		});
	} catch (err) {
		throw new NetworkError(t('Connection to GitHub failed: {0}', err.message));
	}

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new AuthError(t('GitHub returned HTTP error {0} when requesting the code: {1}', response.status, text), 'HTTP_ERROR');
	}

	const data = await response.json();
	if (data.error) {
		throw new AuthError(data.error_description || data.error, data.error);
	}

	return {
		device_code: data.device_code,
		user_code: data.user_code,
		verification_uri: data.verification_uri,
		expires_in: data.expires_in || 900,
		interval: data.interval || 5
	};
}

/**
 * Realiza polling aguardando o usuario autorizar o device code no navegador.
 * @param {object} options
 * @param {string} [options.clientId]
 * @param {string} options.deviceCode
 * @param {number} [options.interval] Intervalo em segundos
 * @param {number} [options.expiresIn] Tempo total limite em segundos
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchFn]
 * @param {(ms: number) => Promise<void>} [options.sleepFn]
 * @param {(newInterval: number) => void} [options.onSlowDown]
 * @returns {Promise<{ accessToken: string, tokenType: string, scope: string }>}
 */
async function pollForToken(options) {
	const clientId = options.clientId || config.getClientId();
	const baseUrl = options.baseUrl || config.getGitHubBase();
	const deviceCode = options.deviceCode;
	const fetchFn = options.fetchFn || globalThis.fetch;
	const sleep = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));

	let interval = options.interval || 5;
	const expiresAt = Date.now() + ((options.expiresIn || 900) * 1000);

	const url = `${baseUrl}/login/oauth/access_token`;

	while (Date.now() < expiresAt) {
		// Espera interval antes de consultar (inclusive antes da primeira consulta - E5.3)
		await sleep(interval * 1000);

		if (options.signal?.aborted) {
			const err = new Error(t('Operation cancelled.'));
			err.name = 'AbortError';
			throw err;
		}

		let response;
		try {
			response = await fetchFn(url, {
				method: 'POST',
				headers: {
					'Accept': 'application/json',
					'Content-Type': 'application/json',
					'User-Agent': 'AgenteCode-Sync'
				},
				body: JSON.stringify({
					client_id: clientId,
					device_code: deviceCode,
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
				}),
				signal: combineSignals(30000, options.signal)
			});
		} catch (err) {
			if (err.name === 'AbortError') {
				throw err;
			}
			// Tolera falhas transitórias de rede se ainda dentro do prazo (E5.3)
			if (Date.now() < expiresAt) {
				continue;
			}
			throw new NetworkError(t('Connection failed while checking the token: {0}', err.message));
		}

		// Tolera respostas 5xx transitórias do GitHub (E5.3)
		if (response.status >= 500) {
			if (Date.now() < expiresAt) {
				continue;
			}
			throw new NetworkError(`GitHub retornou HTTP ${response.status}`);
		}

		const data = await response.json().catch(() => ({}));

		if (data.access_token) {
			const scope = data.scope || '';
			if (!scope.includes('gist')) {
				throw new AuthError(t('The returned token does not have the required permission (gist).'), 'INSUFFICIENT_SCOPE');
			}
			return {
				accessToken: data.access_token,
				tokenType: data.token_type || 'Bearer',
				scope
			};
		}

		if (data.error === 'authorization_pending') {
			continue;
		}

		if (data.error === 'slow_down') {
			interval = (data.interval || interval + 5);
			if (typeof options.onSlowDown === 'function') {
				options.onSlowDown(interval);
			}
			continue;
		}

		if (data.error === 'expired_token') {
			throw new TokenExpiredError();
		}

		if (data.error === 'access_denied') {
			throw new AccessDeniedError();
		}

		throw new AuthError(data.error_description || data.error || t('Unknown authorization error.'), data.error);
	}

	throw new TokenExpiredError(t('The time to authorize in the browser expired.'));
}

/**
 * Consulta informacoes do usuario autenticado (GET /user).
 * @param {string} token
 * @param {object} [options]
 * @param {string} [options.apiBaseUrl]
 * @param {typeof fetch} [options.fetchFn]
 * @returns {Promise<{ login: string, id: number, name?: string, html_url?: string }>}
 */
async function getUser(token, options = {}) {
	const apiBaseUrl = options.apiBaseUrl || config.getGitHubApi();
	const fetchFn = options.fetchFn || globalThis.fetch;

	let response;
	try {
		response = await fetchFn(`${apiBaseUrl}/user`, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Accept': 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'AgenteCode-Sync'
			},
			signal: combineSignals(30000, options.signal)
		});
	} catch (err) {
		throw new NetworkError(t('Failed to get the user profile: {0}', err.message));
	}

	if (response.status === 401) {
		throw new AuthError(t('Token revoked or invalid (401).'), 'UNAUTHORIZED');
	}

	if (!response.ok) {
		throw new AuthError(t('Error querying the user: HTTP {0}', response.status), 'HTTP_ERROR');
	}

	return response.json();
}

module.exports = {
	AuthError,
	TokenExpiredError,
	AccessDeniedError,
	NetworkError,
	startDeviceFlow,
	pollForToken,
	getUser
};
