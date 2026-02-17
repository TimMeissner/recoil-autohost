// SPDX-FileCopyrightText: 2025 The Recoil Autohost Authors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { ConfigManager } from './config.js';

const logger = pino({ level: 'silent' });

function createConfig(overrides?: Partial<{ tachyonServer: string; maxBattles: number }>) {
	return {
		tachyonServer: overrides?.tachyonServer ?? 'localhost',
		authClientId: 'client-id',
		authClientSecret: 'client-secret',
		hostingIP: '127.0.0.1',
		maxBattles: overrides?.maxBattles ?? 10,
	};
}

function createConfigWithAuth(overrides?: Partial<{ authClientSecret: string }>) {
	return {
		...createConfig(),
		authClientSecret: overrides?.authClientSecret ?? 'client-secret',
	};
}

suite('ConfigManager', async () => {
	await test('reloads config and emits connection change event', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'recoil-autohost-config-'));
		const configPath = join(dir, 'config.json');
		await writeFile(configPath, JSON.stringify(createConfig()), 'utf8');

		const manager = await ConfigManager.create(logger, configPath);
		try {
			const reloadedPromise = once(manager, 'reloaded');
			const connectionChangedPromise = once(manager, 'connectionConfigChanged');

			await writeFile(
				configPath,
				JSON.stringify(createConfig({ tachyonServer: 'tachyon.example.com', maxBattles: 20 })),
				'utf8',
			);

			const [[changedFields], [connectionChangedFields]] = await Promise.all([
				reloadedPromise,
				connectionChangedPromise,
			]);

			assert.ok(changedFields.includes('tachyonServer'));
			assert.ok(changedFields.includes('maxBattles'));
			assert.deepEqual(connectionChangedFields, ['tachyonServer']);
			assert.equal(manager.config.tachyonServer, 'tachyon.example.com');
			assert.equal(manager.config.maxBattles, 20);
		} finally {
			await manager.close();
		}
	});

	await test('keeps previous config on invalid file update', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'recoil-autohost-config-'));
		const configPath = join(dir, 'config.json');
		await writeFile(configPath, JSON.stringify(createConfig()), 'utf8');

		const manager = await ConfigManager.create(logger, configPath);
		try {
			await writeFile(configPath, '{', 'utf8');
			await setTimeout(600);

			assert.equal(manager.config.tachyonServer, 'localhost');
			assert.equal(manager.config.maxBattles, 10);
		} finally {
			await manager.close();
		}
	});

	await test('auth config changes trigger connection config event', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'recoil-autohost-config-'));
		const configPath = join(dir, 'config.json');
		await writeFile(configPath, JSON.stringify(createConfigWithAuth()), 'utf8');

		const manager = await ConfigManager.create(logger, configPath);
		try {
			const connectionChangedPromise = once(manager, 'connectionConfigChanged');
			await writeFile(
				configPath,
				JSON.stringify(createConfigWithAuth({ authClientSecret: 'rotated-secret' })),
				'utf8',
			);

			const [connectionChangedFields] = await connectionChangedPromise;
			assert.deepEqual(connectionChangedFields, ['authClientSecret']);
		} finally {
			await manager.close();
		}
	});
});
