// SPDX-FileCopyrightText: 2025 The Recoil Autohost Authors
//
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { GamesManager, type Env as GamesManagerEnv } from './games.js';

test('capacity follows config maxBattles updates', () => {
	const env: GamesManagerEnv = {
		logger: pino({ level: 'silent' }),
		config: {
			engineStartPort: 20000,
			engineAutohostStartPort: 22000,
			maxPortsUsed: 1000,
			maxBattles: 10,
			hostingIP: '127.0.0.1',
			engineBindIP: '0.0.0.0',
			engineSettings: {},
			maxGameDurationSeconds: 8 * 60 * 60,
		},
	};

	const manager = new GamesManager(env);
	assert.equal(manager.capacity.maxBattles, 10);

	env.config.maxBattles = 25;
	assert.equal(manager.capacity.maxBattles, 25);
});
