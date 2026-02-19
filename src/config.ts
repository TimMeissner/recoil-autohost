// SPDX-FileCopyrightText: 2025 The Recoil Autohost Authors
//
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises';
import { z } from 'zod';
import dotenv from 'dotenv';

/**
 * Zod schema for the full application config.
 *
 * Every field with `.default()` is optional in the input; the parser fills in
 * the default when the key is missing or `undefined`.
 */
export const ConfigSchema = z.object({
	tachyonServer: z.string().describe('Hostname of the tachyon server to connect to.'),
	tachyonServerPort: z.coerce
		.number()
		.nullable()
		.default(null)
		.describe(
			'Optional port of the tachyon server, by default standard HTTPS port will be used.',
		),
	useSecureConnection: z
		.boolean()
		.nullable()
		.default(null)
		.describe(
			'Whether to use SSL to connect to tachyon server. Defaults to true, except for localhost.',
		),
	authClientId: z.string().describe('OAuth2 client id for authentication.'),
	authClientSecret: z.string().describe('OAuth2 client secret for authentication'),
	hostingIP: z.ipv4().describe('The IP advertised to clients for connecting to the battle.'),
	engineBindIP: z.ipv4()
		.default('0.0.0.0')
		.describe('The local IP/interface used by engine to bind the battle socket.'),
	maxReconnectDelaySeconds: z.coerce
		.number()
		.min(1)
		.default(30)
		.describe('Maximum delay for reconnects to tachyon server.'),
	engineSettings: z
		.record(z.string(), z.string())
		.default({})
		.describe('Engine settings to be serialized into springsettings.cfg'),
	maxBattles: z.coerce
		.number()
		.int()
		.min(1)
		.default(50)
		.describe('Maximum number of battles that can be hosted.'),
	maxUpdatesSubscriptionAgeSeconds: z.coerce
		.number()
		.default(10 * 60)
		.describe(
			'For how long autohost will keep engine updates. This determines the max time used in subscribeUpdates.',
		),
	engineStartPort: z.coerce
		.number()
		.int()
		.min(1025)
		.max(65535)
		.default(20000)
		.describe('Start of the port range used by engine instances.'),
	engineAutohostStartPort: z.coerce
		.number()
		.int()
		.min(1025)
		.max(65535)
		.default(22000)
		.describe('Start of the port range used by engine for autohost interface on localhost.'),
	maxPortsUsed: z.coerce
		.number()
		.int()
		.min(1)
		.default(1000)
		.describe(
			'Maximum number of ports that can be used by the service, this +StartPorts define the port range.',
		),
	engineInstallTimeoutSeconds: z.coerce
		.number()
		.int()
		.min(5)
		.default(10 * 60)
		.describe('Hard timeout for engine installation by engine manager'),
	maxGameDurationSeconds: z.coerce
		.number()
		.min(60 * 60)
		.default(8 * 60 * 60)
		.describe('How many seconds to wait before automatically killing the game.'),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Mapping from environment variable names to config keys.
 *
 * Only env vars that are explicitly set (i.e. not `undefined`) will be picked
 * up, so they never accidentally override JSON values with empty strings.
 */
const ENV_MAP: Record<string, keyof Config> = {
	AUTOHOST_TACHYON_SERVER: 'tachyonServer',
	AUTOHOST_TACHYON_SERVER_PORT: 'tachyonServerPort',
	AUTOHOST_USE_SECURE_CONNECTION: 'useSecureConnection',
	AUTOHOST_AUTH_CLIENT_ID: 'authClientId',
	AUTOHOST_AUTH_CLIENT_SECRET: 'authClientSecret',
	AUTOHOST_HOSTING_IP: 'hostingIP',
	AUTOHOST_ENGINE_BIND_IP: 'engineBindIP',
	AUTOHOST_MAX_RECONNECT_DELAY_SECONDS: 'maxReconnectDelaySeconds',
	AUTOHOST_ENGINE_SETTINGS: 'engineSettings',
	AUTOHOST_MAX_BATTLES: 'maxBattles',
	AUTOHOST_MAX_UPDATES_SUBSCRIPTION_AGE_SECONDS: 'maxUpdatesSubscriptionAgeSeconds',
	AUTOHOST_ENGINE_START_PORT: 'engineStartPort',
	AUTOHOST_ENGINE_AUTOHOST_START_PORT: 'engineAutohostStartPort',
	AUTOHOST_MAX_PORTS_USED: 'maxPortsUsed',
	AUTOHOST_ENGINE_INSTALL_TIMEOUT_SECONDS: 'engineInstallTimeoutSeconds',
	AUTOHOST_MAX_GAME_DURATION_SECONDS: 'maxGameDurationSeconds',
};

/**
 * Read environment variables and return a partial config object.
 *
 * - Boolean strings ("true" / "false") are coerced to booleans.
 * - AUTOHOST_ENGINE_SETTINGS is parsed as a JSON object.
 * - Numeric coercion is left to Zod (via `z.coerce.number()`).
 * - Only env vars that are defined are included.
 */
function readEnv(env: Record<string, string | undefined>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
		const raw = env[envKey];
		if (raw === undefined) continue;

		if (configKey === 'useSecureConnection') {
			if (raw.toLowerCase() === 'true') {
				result[configKey] = true;
			} else if (raw.toLowerCase() === 'false') {
				result[configKey] = false;
			} else {
				result[configKey] = raw;
			}
		} else if (configKey === 'engineSettings') {
			try {
				result[configKey] = JSON.parse(raw);
			} catch {
				throw new Error(
					`Invalid JSON in ${envKey}: expected a JSON object like '{"key":"value"}', got: ${raw}`,
				);
			}
		} else {
			result[configKey] = raw;
		}
	}

	return result;
}

/**
 * Load, merge, and validate the application config.
 *
 * Precedence (highest wins):
 *   1. Environment variables (real env + `.env` file loaded by dotenv)
 *   2. JSON config file (if `configPath` is provided)
 *   3. Schema defaults
 *
 * @param configPath  Optional path to a JSON config file.
 *                    When omitted, config is read entirely from env vars.
 */
export async function loadConfig(configPath?: string): Promise<Config> {
	dotenv.config();

	let fileConfig: Record<string, unknown> = {};
	if (configPath) {
		fileConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
	}

	const envConfig = readEnv(process.env);
	const merged = { ...fileConfig, ...envConfig };

	const result = ConfigSchema.safeParse(merged);
	if (!result.success) {
		const formatted = result.error.issues
			.map((i) => `  ${i.path.join('.')}: ${i.message}`)
			.join('\n');
		throw new Error(`Invalid config:\n${formatted}`);
	}

	return result.data;
}
