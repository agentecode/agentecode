/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Cópia de github.com/AlessandroLobo/claude-usage-statusbar (MIT, versão 0.10.0); a fonte do código fica lá.

'use strict';

// Consulta dos limites 5h/7d direto na API de uso da Anthropic, no máximo uma vez por máquina e
// por intervalo: as janelas abertas dividem um cache com trava em ~/.claude-usage-statusbar/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const core = require('./core');
const { t } = require('../i18n');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const LOCK_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
// Token que vence em menos que isso é tratado como vencido: o Claude Code renova sozinho.
const EXPIRY_SKEW_MS = 5 * 60_000;

const storeDir = () => path.join(os.homedir(), '.claude-usage-statusbar');
const storeFile = dir => path.join(dir, 'usage.json');

const emptyStore = () => ({ v: 1, limits: null, nextPollAt: 0, failures: 0, lastError: null });

const readStore = dir => {
  try {
    const j = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    return j && j.v === 1 ? j : null;
  } catch {
    return null;
  }
};

const writeStore = (dir, data) => {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `usage.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.renameSync(tmp, storeFile(dir));
  } catch {
    // No Windows o rename falha se outra janela estiver lendo o arquivo naquele instante.
    fs.writeFileSync(storeFile(dir), JSON.stringify(data));
    fs.rmSync(tmp, { force: true });
  }
};

// Trava entre janelas: só quem a obtém consulta a API; uma trava abandonada expira em 60 s.
const acquireLock = (dir, now) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'poll.lock');
  const mine = JSON.stringify({ at: now, pid: process.pid, id: crypto.randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8') === mine) fs.unlinkSync(file);
        } catch {
          /* já removida */
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      let at = 0;
      try {
        at = JSON.parse(fs.readFileSync(file, 'utf8')).at || 0;
      } catch {
        /* trava ilegível conta como abandonada */
      }
      if (now - at <= LOCK_TTL_MS) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
};

// No macOS o Claude Code guarda as credenciais no Keychain; nos demais sistemas, em ~/.claude/.credentials.json.
const keychainService = () => {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? `Claude Code-credentials-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)}` : 'Claude Code-credentials';
};

const readKeychain = () =>
  new Promise(resolve => {
    execFile('security', ['find-generic-password', '-s', keychainService(), '-w'], { timeout: 10_000, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? { error: t('credential not found in the Keychain') } : core.parseCredentials(stdout)),
    );
  });

const loadCredentials = async () => {
  if (process.platform === 'darwin') {
    const fromKeychain = await readKeychain();
    if (!fromKeychain.error) return fromKeychain;
  }
  return core.readCredentials();
};

const parseRetryAfter = (value, now) => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
};

const request = async (fetchImpl, token) => {
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
        'User-Agent': 'claude-usage-statusbar',
      },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

// Consulta a API se for a vez desta máquina; devolve true quando gravou uma leitura nova.
// Com `wantFresh` (houve uso do Claude depois da última leitura), consulta antes do intervalo,
// respeitando o espaçamento mínimo e nunca durante um recuo por erro.
const isDue = (store, now, wantFresh, minGapMs) =>
  now >= store.nextPollAt || (wantFresh && !(store.failures > 0) && now - (store.lastAttemptAt || 0) >= minGapMs);

const poll = async ({ baseMs, minGapMs = 60_000, wantFresh = false, dir = storeDir(), now = Date.now(), fetchImpl = globalThis.fetch, credentials = loadCredentials }) => {
  if (typeof fetchImpl !== 'function') return false;
  if (!isDue(readStore(dir) || emptyStore(), now, wantFresh, minGapMs)) return false;
  const release = acquireLock(dir, now);
  if (!release) return false;
  try {
    // Outra janela pode ter consultado entre a primeira leitura e a trava.
    const store = readStore(dir) || emptyStore();
    if (!isDue(store, now, wantFresh, minGapMs)) return false;

    const cred = await credentials();
    if (cred.error || (cred.expiresAt !== null && cred.expiresAt - EXPIRY_SKEW_MS <= now)) {
      writeStore(dir, { ...store, nextPollAt: now + 60_000, lastError: cred.error || t('token expired, waiting for Claude Code to renew it') });
      return false;
    }

    let status = 0;
    let retryAfterMs = null;
    let limits = store.limits;
    let lastError = null;
    try {
      const res = await request(fetchImpl, cred.token);
      status = res.status;
      retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now);
      if (status === 200) {
        const parsed = core.parseUsageBody(await res.json(), Date.now());
        if (parsed) limits = parsed;
        else {
          status = 0;
          lastError = t('API response without the limits');
        }
      } else {
        lastError = status === 429 ? t('API rate-limiting the requests (HTTP 429)') : status === 401 || status === 403 ? t('token rejected (HTTP {0})', status) : `HTTP ${status}`;
      }
    } catch {
      lastError = t('network failure');
    }
    const failures = status === 200 ? 0 : (store.failures || 0) + 1;
    const done = Date.now();
    writeStore(dir, { v: 1, limits, nextPollAt: done + core.nextPollDelay({ status, retryAfterMs, failures }, baseMs), failures, lastError, lastAttemptAt: done });
    return status === 200;
  } finally {
    release();
  }
};

// Leitura compartilhada pelas janelas, com idade calculada agora.
const readShared = (now, staleMinutes, dir = storeDir()) => {
  const store = readStore(dir);
  return { limits: store && store.limits ? core.withAge(store.limits, now, staleMinutes) : null, lastError: store ? store.lastError : null };
};

module.exports = { poll, readShared, acquireLock, parseRetryAfter, keychainService, storeDir };
