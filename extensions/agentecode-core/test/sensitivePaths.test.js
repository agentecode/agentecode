/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { sensitiveKind, sensitiveReason } = require('../lib/sensitivePaths');

describe('Arquivos sensiveis na revisao', () => {
	test('arquivos comuns nao sao marcados', () => {
		for (const file of ['src/app.ts', 'Controllers/LoginController.cs', 'login.css', 'README.md', 'src/environment.ts']) {
			assert.equal(sensitiveKind(file), undefined, file);
		}
	});

	test('o que executa sozinho', () => {
		for (const file of ['.vscode/tasks.json', '.github/workflows/build.yml', 'package.json', 'scripts/deploy.ps1', 'build.sh', '.husky/pre-commit', '.claude/settings.local.json']) {
			assert.equal(sensitiveKind(file), 'runs', file);
		}
	});

	test('segredos', () => {
		for (const file of ['.env', '.env.local', 'config/server.pem', 'Api/appsettings.Production.json', 'secrets.json']) {
			assert.equal(sensitiveKind(file), 'secrets', file);
		}
		assert.equal(sensitiveKind('Api/appsettings.json'), undefined, 'o appsettings base nao entra');
	});

	test('dependencias', () => {
		for (const file of ['package-lock.json', 'src/Api/Api.csproj', 'requirements.txt']) {
			assert.equal(sensitiveKind(file), 'dependencies', file);
		}
	});

	test('vale em qualquer pasta, com barras do Windows e sem diferenciar maiusculas', () => {
		assert.equal(sensitiveKind('app\\.vscode\\Tasks.JSON'), 'runs');
		assert.equal(sensitiveKind('C:/work/proj/.vscode/launch.json'), 'runs');
		assert.equal(sensitiveKind('sub/dir/.ENV'), 'secrets');
	});

	test('o asterisco simples nao atravessa pastas', () => {
		assert.equal(sensitiveKind('.vscode/other/tasks.json'), undefined);
		assert.equal(sensitiveKind('.github/workflows/nested/deep/ci.yml'), 'runs', 'o ** atravessa');
	});

	test('padroes do usuario viram a categoria custom, e os de fabrica vencem', () => {
		assert.equal(sensitiveKind('db/migrations/001.sql', ['db/migrations/**']), 'custom');
		assert.equal(sensitiveKind('web.config', ['web.config']), 'custom');
		assert.equal(sensitiveKind('.env', ['.env']), 'secrets');
		assert.equal(sensitiveKind('a.sql', ['', '   ', 42, null]), undefined, 'valores invalidos sao ignorados');
	});

	test('cada categoria tem um motivo', () => {
		const reasons = ['runs', 'secrets', 'dependencies', 'custom'].map(sensitiveReason);
		assert.equal(new Set(reasons).size, 4);
		assert.ok(reasons.every(text => text.length > 10));
	});
});
