// SPDX-FileCopyrightText: 2025 The Recoil Autohost Authors
//
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { Ajv, JSONSchemaType, type Plugin } from 'ajv';
import ajvFormats, { type FormatsPluginOptions } from 'ajv-formats';
import { FSWatcher } from 'chokidar';
import type { Logger } from 'pino';
import { TypedEmitter } from 'tiny-typed-emitter';
// https://github.com/ajv-validator/ajv-formats/issues/85#issuecomment-2377962689
const addFormats = ajvFormats as unknown as Plugin<FormatsPluginOptions>;

export interface Config {
	tachyonServer: string;
	tachyonServerPort: number | null;
	useSecureConnection: boolean | null;
	authClientId: string;
	authClientSecret: string;
	hostingIP: string;
	engineBindIP: string;
	maxReconnectDelaySeconds: number;
	engineSettings: { [k: string]: string };
	maxBattles: number;
	maxUpdatesSubscriptionAgeSeconds: number;
	engineStartPort: number;
	engineAutohostStartPort: number;
	maxPortsUsed: number;
	engineInstallTimeoutSeconds: number;
	engineDownloadMaxAttempts: number;
	engineDownloadRetryBackoffBaseMs: number;
	engineCdnBaseUrl: string;
	maxGameDurationSeconds: number;
}

const ConfigSchema: JSONSchemaType<Config> = {
	$id: 'Config',
	type: 'object',
	properties: {
		tachyonServer: {
			type: 'string',
			description: 'Hostname of the tachyon server to connect to.',
		},
		tachyonServerPort: {
			type: 'number',
			description:
				'Optional port of the tachyon server, by default standard HTTPS port will be used.',
		},
		useSecureConnection: {
			type: 'boolean',
			description:
				'Whatever to use HTTPS/WSS to connect to tachyon server. Defaults to true, except for localhost.',
		},
		authClientId: {
			type: 'string',
			description: 'OAuth2 client id for authentication.',
		},
		authClientSecret: {
			type: 'string',
			description: 'OAuth2 client secret for authentication',
		},
		hostingIP: {
			type: 'string',
			description: 'The IP advertised to clients for connecting to the battle.',
			format: 'ipv4',
		},
		engineBindIP: {
			type: 'string',
			description: 'The local IP/interface used by engine to bind the battle socket.',
			default: '0.0.0.0',
			format: 'ipv4',
		},
		maxReconnectDelaySeconds: {
			type: 'number',
			description: 'Maximum delay for reconnects to tachyon server.',
			default: 30,
			minimum: 1,
		},
		engineSettings: {
			type: 'object',
			description: 'Engine settings to be serialized into springsettings.cfg',
			additionalProperties: { type: 'string' },
			default: {},
			required: [],
		},
		maxBattles: {
			type: 'integer',
			description: 'Maximum number of battler that can be hosted.',
			default: 50,
			minimum: 1,
		},
		maxUpdatesSubscriptionAgeSeconds: {
			type: 'number',
			description:
				'For how long autohost will keep engine updates. This determines the max time used in subscribeUpdates.',
			default: 10 * 60,
		},
		engineStartPort: {
			type: 'integer',
			description: 'Start of the port range used by engine instances.',
			default: 20000,
			minimum: 1025,
			maximum: 65535,
		},
		engineAutohostStartPort: {
			type: 'integer',
			description:
				'Start of the port range used by engine for autohost interface on localhost.',
			default: 22000,
			minimum: 1025,
			maximum: 65535,
		},
		maxPortsUsed: {
			type: 'integer',
			description:
				'Maximum number of ports that can be used by the service, this +StartPorts define the port range.',
			default: 1000,
			minimum: 1,
		},
		engineInstallTimeoutSeconds: {
			type: 'integer',
			description: 'Hard timeout for engine installation by engine manager',
			default: 10 * 60,
			minimum: 5,
		},
		engineDownloadMaxAttempts: {
			type: 'integer',
			description: 'Maximum number of attempts to download and verify an engine archive.',
			default: 3,
			minimum: 1,
		},
		engineDownloadRetryBackoffBaseMs: {
			type: 'integer',
			description:
				'Base backoff in milliseconds used between engine download retry attempts.',
			default: 1000,
			minimum: 1000,
		},
		engineCdnBaseUrl: {
			type: 'string',
			description: 'Base URL of BAR CDN API used for engine release lookup.',
			default: 'https://files-cdn.beyondallreason.dev',
			format: 'uri',
		},
		maxGameDurationSeconds: {
			type: 'number',
			description: 'How many seconds to wait before automatically killing the game.',
			default: 8 * 60 * 60,
			minimum: 60 * 60,
		},
	},
	required: ['tachyonServer', 'authClientId', 'authClientSecret', 'hostingIP'],
	additionalProperties: true,
};

const ajv = new Ajv({ strict: true, useDefaults: true, coerceTypes: true });
addFormats(ajv);
const validateConfig = ajv.compile(ConfigSchema);

export async function loadConfig(path: string): Promise<Config> {
	const config = JSON.parse(await fs.readFile(path, 'utf-8'));
	if (!validateConfig(config)) {
		throw new Error('Invalid config', {
			cause: new Error(ajv.errorsText(validateConfig.errors)),
		});
	}
	return config;
}

type ConfigField = keyof Config;

type ConnectionConfigField =
	| 'tachyonServer'
	| 'tachyonServerPort'
	| 'useSecureConnection'
	| 'authClientId'
	| 'authClientSecret';
type DangerousConfigField = 'engineStartPort' | 'engineAutohostStartPort';

const connectionFields = new Set<ConfigField>([
	'tachyonServer',
	'tachyonServerPort',
	'useSecureConnection',
	'authClientId',
	'authClientSecret',
]);
const dangerousFields = new Set<ConfigField>(['engineStartPort', 'engineAutohostStartPort']);

export interface ConfigManagerEvents {
	reloaded: (changedFields: ConfigField[]) => void;
	connectionConfigChanged: (changedFields: ConnectionConfigField[]) => void;
}

export class ConfigManager extends TypedEmitter<ConfigManagerEvents> {
	private watcher: FSWatcher;
	private pendingReload: Promise<void> = Promise.resolve();

	private constructor(
		private logger: Logger,
		private configPath: string,
		public config: Config,
	) {
		super();
		this.watcher = new FSWatcher({
			awaitWriteFinish: {
				pollInterval: 100,
				stabilityThreshold: 300,
			},
		});

		this.watcher.on('add', () => this.queueReload());
		this.watcher.on('change', () => this.queueReload());
		this.watcher.on('error', (error: unknown) => {
			if (error instanceof Error) {
				this.logger.error(error, 'config watcher error');
			} else {
				this.logger.error({ error }, 'unknown config watcher error');
			}
		});
		this.watcher.add(this.configPath);
	}

	public static async create(logger: Logger, configPath: string): Promise<ConfigManager> {
		const config = await loadConfig(configPath);
		return new ConfigManager(logger, configPath, config);
	}

	public close(): Promise<void> {
		return this.watcher.close();
	}

	private queueReload() {
		this.pendingReload = this.pendingReload
			.then(async () => this.reload())
			.catch((error: unknown) => {
				if (error instanceof Error) {
					this.logger.error(error, 'config reload failed');
				} else {
					this.logger.error({ error }, 'config reload failed');
				}
			});
	}

	private async reload() {
		let nextConfig: Config;
		try {
			nextConfig = await loadConfig(this.configPath);
		} catch (error) {
			this.logger.error(error, 'failed to reload config, keeping previous config');
			return;
		}

		const changedFields = getChangedConfigFields(this.config, nextConfig);
		if (changedFields.length === 0) {
			return;
		}

		Object.assign(this.config, nextConfig);
		this.logger.info({ changedFields }, 'reloaded config');
		this.emit('reloaded', changedFields);

		const changedConnectionFields = changedFields.filter((field): field is ConnectionConfigField =>
			connectionFields.has(field),
		);
		if (changedConnectionFields.length > 0) {
			this.logger.info(
				{ changedConnectionFields },
				'connection config changed, reconnect required',
			);
			this.emit('connectionConfigChanged', changedConnectionFields);
		}

		const changedDangerousFields = changedFields.filter((field): field is DangerousConfigField =>
			dangerousFields.has(field),
		);
		if (changedDangerousFields.length > 0) {
			this.logger.warn(
				{ changedDangerousFields },
				'engine port range settings changed; only future games use new values',
			);
		}
	}
}

function getChangedConfigFields(current: Config, next: Config): ConfigField[] {
	const keys = Object.keys(next) as ConfigField[];
	return keys.filter((key) => !isDeepStrictEqual(current[key], next[key]));
}
