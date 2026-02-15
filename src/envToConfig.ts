// SPDX-FileCopyrightText: 2026 The Recoil Autohost Authors
//
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises';

type ConfigFromEnv = {
	tachyonServer?: string;
	tachyonServerPort?: number;
	useSecureConnection?: boolean;
	authClientId?: string;
	authClientSecret?: string;
	hostingIP?: string;
	engineBindIP?: string;
	maxReconnectDelaySeconds?: number;
	engineSettings?: Record<string, string>;
	maxBattles?: number;
	maxUpdatesSubscriptionAgeSeconds?: number;
	engineStartPort?: number;
	engineAutohostStartPort?: number;
	maxPortsUsed?: number;
	engineInstallTimeoutSeconds?: number;
	maxGameDurationSeconds?: number;
};

function parseBoolean(raw: string | undefined): boolean | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const normalized = raw.trim().toLowerCase();
	if (normalized === 'true' || normalized === '1') {
		return true;
	}
	if (normalized === 'false' || normalized === '0') {
		return false;
	}
	return undefined;
}

function parseNumber(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === '') {
		return undefined;
	}
	const parsed = Number(raw);
	if (Number.isNaN(parsed)) {
		return undefined;
	}
	return parsed;
}

function parseStringMap(raw: string | undefined): Record<string, string> | undefined {
	if (raw === undefined || raw.trim() === '') {
		return undefined;
	}

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return undefined;
		}
		const entries = Object.entries(parsed);
		const result: Record<string, string> = {};
		for (const [key, value] of entries) {
			if (typeof value === 'string') {
				result[key] = value;
			} else if (value !== undefined && value !== null) {
				result[key] = String(value);
			}
		}
		return result;
	} catch {
		return undefined;
	}
}

function readConfigFromEnv(env: NodeJS.ProcessEnv): ConfigFromEnv {
	return {
		tachyonServer: env['tachyonServer'],
		tachyonServerPort: parseNumber(env['tachyonServerPort']),
		useSecureConnection: parseBoolean(env['useSecureConnection']),
		authClientId: env['authClientId'],
		authClientSecret: env['authClientSecret'],
		hostingIP: env['hostingIP'],
		engineBindIP: env['engineBindIP'],
		maxReconnectDelaySeconds: parseNumber(env['maxReconnectDelaySeconds']),
		engineSettings: parseStringMap(env['engineSettings']),
		maxBattles: parseNumber(env['maxBattles']),
		maxUpdatesSubscriptionAgeSeconds: parseNumber(env['maxUpdatesSubscriptionAgeSeconds']),
		engineStartPort: parseNumber(env['engineStartPort']),
		engineAutohostStartPort: parseNumber(env['engineAutohostStartPort']),
		maxPortsUsed: parseNumber(env['maxPortsUsed']),
		engineInstallTimeoutSeconds: parseNumber(env['engineInstallTimeoutSeconds']),
		maxGameDurationSeconds: parseNumber(env['maxGameDurationSeconds'])
	};
}

async function main(argv: string[]) {
	if (argv.length < 3) {
		throw new Error('usage: node dist/env-to-config.js <config-path>');
	}

	const configPath = argv[2];
	const config = readConfigFromEnv(process.env);
	await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

if (import.meta.filename === process.argv[1]) {
	await main(process.argv);
}
