// SPDX-FileCopyrightText: 2025 The Recoil Autohost Authors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Engine runner module providing functionality to start and manage the engine.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as tdf from 'recoil-tdf';
import { TypedEmitter } from 'tiny-typed-emitter';
import { parsePacket, type Event, EventType, PacketParseError } from './engineAutohostInterface.js';
import {
	engineBinaryName,
	engineClientBinaryName,
	engineHeadlessBinaryName,
} from './engineBinary.js';
import { scriptGameFromStartRequest, StartScriptGenError } from './startScriptGen.js';
import type { AutohostStartRequestData } from 'tachyon-protocol/types';
import { TachyonError } from './tachyonTypes.js';
import { Environment } from './environment.js';

function serializeEngineSettings(obj: { [k: string]: string }): string {
	return Object.entries(obj)
		.map(([key, val]) => `${key}=${val}\n`)
		.join('');
}

/**
 * Events emitted by the engine runner
 */
export interface EngineRunnerEvents {
	// Emitted when a packet is received from the engine.
	packet: (ev: Event) => void;

	// Emitted when an error occurs, the engine runner will close itself after.
	// This event is emitted only once, after the first error, any subsequent
	// errors are ignored.
	error: (err: Error) => void;

	// Emitted after the engine has started and the first SERVER_STARTED packet
	// has been received
	start: () => void;

	// Emitted when the engine has exited and the UDP server has been closed so
	// the autohost port is free to use again. This event is emitted always,
	// even if the starting was interrupted by an error.
	exit: () => void;
}

/**
 * Represents the state of the engine runner
 *
 * The possible transitions are:
 * - None -> Starting
 * - Starting -> Running | Stopping
 * - Running -> Stopping
 * - Stopping -> Stopped
 */
enum State {
	None,
	Starting,
	Running,
	Stopping,
	Stopped,
}

/**
 * Options for the engine runner
 */
interface Opts {
	startRequest: AutohostStartRequestData;
	autohostPort: number;
	hostIP: string;
	hostPort: number;
	spectatorClient?: {
		hostIP: string;
		name: string;
		password: string;
	};
}

export interface EngineRunner extends TypedEmitter<EngineRunnerEvents> {
	sendPacket(packet: Buffer): Promise<void>;
	close(): void;
}

interface Mocks {
	spawn?: typeof spawn;
}

interface Config {
	engineSettings: { [k: string]: string };
	engineInstallTimeoutSeconds?: number;
	engineDownloadMaxAttempts?: number;
	engineDownloadRetryBackoffBaseMs?: number;
	engineCdnBaseUrl?: string;
	rapidRepoMasterUrl?: string;
}

export type Env = Environment<Config, Mocks>;

/**
 * Engine runner class responsible for lifecycle of the engine process and the
 * UDP server for autohost packets.
 *
 * Use the `runEngine` function to create an instance of this class.
 */
export class EngineRunnerImpl extends TypedEmitter<EngineRunnerEvents> implements EngineRunner {
	private udpServer: null | dgram.Socket = null;
	private engineAutohostPort: number = 0;
	private engineProcess: null | ChildProcess = null;
	private spectatorProcess: null | ChildProcess = null;
	private engineSpawned: boolean = false;
	private spectatorSpawned: boolean = false;
	private state: State = State.None;
	private logger: Env['logger'];
	private luamsgRegex: RegExp | null = null;
	private opts: Opts | null = null;
	private instanceDir: string | null = null;

	public constructor(private env: Env) {
		super();
		this.logger = env.logger.child({ class: 'EngineRunner' });
	}

	/**
	 * Should be only called by `runEngine` function as part of initialization.
	 *
	 * @param opts Options for the engine runner, but with `spawnMock` option
	 *             that can be used for testing.
	 */
	public _run(opts: Opts) {
		this.opts = opts;
		this.logger = this.logger.child({ battleId: opts.startRequest.battleId });
		if (this.state != State.None) {
			throw new Error('EngineRunner already started');
		}
		this.state = State.Starting;
		const run = async () => {
			if (opts.startRequest.luamsgRegexp) {
				try {
					this.luamsgRegex = new RegExp(opts.startRequest.luamsgRegexp);
				} catch (err) {
					throw new TachyonError('invalid_request', `Invalid luamsg RegExp: ${err}`);
				}
			}

			const instanceDir = await this.setupInstanceDir(opts);
			this.instanceDir = instanceDir;
			await this.startUdpServer(opts.autohostPort);
			await this.startEngine(instanceDir, opts.startRequest);

			// The last part of startup is handled in the packed handler
		};
		run().catch((err) => this.handleError(err));
	}

	/**
	 * Send an autohost packet to the running engine process
	 *
	 * Promise rejects if the engine is not in running state.
	 *
	 * @param packet The buffer serialized with autohostInterface
	 *               serializeMessagePacket or serializeCommandPacket
	 */
	public async sendPacket(packet: Buffer): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.state != State.Running) {
				throw new Error('Failed to send packet, engine not running');
			}
			this.udpServer!.send(packet, this.engineAutohostPort, '127.0.0.1', (err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	/**
	 * Close the engine runner and stop the engine process and the UDP server.
	 *
	 * This function can be called any time, any number of times.
	 */
	public close(): void {
		if (this.state >= State.Stopping) return;
		this.state = State.Stopping;

		// TODO: handle instance dir somehow?

		this.killEngine();
		this.killSpectator();
		if (this.udpServer) {
			this.udpServer.close();
		}
		this.maybeEmitExit();
	}

	private killEngine(): void {
		if (this.engineProcess == null || !this.engineSpawned) return;

		// If the engine doesn't exit in 20 seconds after SIGTERM, we kill it
		// with SIGKILL. This is a bit aggressive but we don't want to wait
		// forever for the engine to exit, it should exit quickly.
		const engineSigKill = setTimeout(() => {
			this.logger.error("Engine didn't exit after SIGTERM, trying with SIGKILL");
			this.engineProcess?.kill('SIGKILL');
		}, 20000);

		this.engineProcess.once('exit', () => {
			// We must clear the timeout because the pid might be reused
			// and the timeout would kill a different process.
			clearTimeout(engineSigKill);
		});

		if (!this.engineProcess.kill('SIGTERM')) {
			// This should never happen, if it does there isn't much we
			// can do here except unref and log it :(
			this.engineProcess.unref();
			this.logger.error('Failed to SIGTERM engine process, it might linger');
		}
	}

	private killSpectator(): void {
		if (this.spectatorProcess == null || !this.spectatorSpawned) return;

		const spectatorSigKill = setTimeout(() => {
			this.logger.warn("Spectator didn't exit after SIGTERM, trying with SIGKILL");
			this.spectatorProcess?.kill('SIGKILL');
		}, 10000);

		this.spectatorProcess.once('exit', () => {
			clearTimeout(spectatorSigKill);
		});

		if (!this.spectatorProcess.kill('SIGTERM')) {
			this.spectatorProcess.unref();
			this.logger.warn('Failed to SIGTERM spectator process, it might linger');
		}
	}

	private maybeEmitExit(): void {
		// We can only emit exit when both the engine and the UDP server are
		// stopped because we need to ensure that autohost UDP port isn't used
		// for anything anymore and can be reused:
		//  - if the engine is stopped but the UDP server is still running, the
		//    autohost port is still in use and we can't start new server.
		//  - if the UDP server is stopped but the engine is still running, the
		//	  engine might still be sending packets to the autohost port.
		if (
			this.state == State.Stopping &&
			this.engineProcess == null &&
			this.spectatorProcess == null &&
			this.udpServer == null
		) {
			this.state = State.Stopped;
			// Must be in next tick because we can get here directly from the close call
			// and not all listeners might be attached yet.
			process.nextTick(() => {
				this.emit('exit');
			});
		}
	}

	private handleError(err: Error): void {
		if (this.state >= State.Stopping) return;
		this.emit('error', err);
		this.close();
	}

	private async startUdpServer(autohostPort: number): Promise<void> {
		if (this.state != State.Starting) return;

		this.udpServer = dgram.createSocket('udp4');
		this.udpServer.bind(autohostPort, '127.0.0.1');
		this.udpServer.on('error', (err) => this.handleError(err));
		this.udpServer.on('message', (msg, rinfo) => this.handleAutohostPacket(msg, rinfo));
		this.udpServer.on('close', () => {
			this.udpServer = null;
			this.maybeEmitExit();
		});
	}

	private handleAutohostPacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
		try {
			const packet = parsePacket(msg);
			if (this.state == State.Starting) {
				if (packet.type != EventType.SERVER_STARTED) {
					// Maybe this is a bit brutal? We could try to ignore the packet
					// and wait for the next one, but maybe it's better to fail if the
					// packed successfully parsed as engine packet and let the autohost
					// try some other port.
					this.handleError(new Error('Expected SERVER_STARTED packet as first packet'));
					return;
				}
				this.engineAutohostPort = rinfo.port;
				this.state = State.Running;
				this.startSpectator().catch((err) => {
					this.logger.warn(err, 'failed to start spectator sidecar');
				});
				this.emit('start');
			}
			if (this.engineAutohostPort != rinfo.port) {
				this.logger.warn(
					{ sourcePort: rinfo.port },
					`Received packet from ${rinfo.port}, blocked`,
				);
				return;
			}

			// Don't emit luamsg's not matching start script regexp.
			if (
				packet.type === EventType.GAME_LUAMSG &&
				(this.luamsgRegex === null || !this.luamsgRegex.test(packet.data.toString('utf8')))
			) {
				return;
			}
			this.emit('packet', packet);
		} catch (err) {
			// Don't crash the server on packet parsing errors, it might have been
			// a random packet from localhost or something.
			if (err instanceof PacketParseError) {
				this.logger.warn(err, 'Failed to parse packet');
			} else {
				this.logger.error(err, 'Unexpected error when handling packet');
			}
		}
	}

	private async startSpectator(): Promise<void> {
		if (!this.opts?.spectatorClient || !this.instanceDir) {
			return;
		}

		const engineDir = path.resolve('engines', this.opts.startRequest.engineVersion);
		await this.ensureGameContent(engineDir, this.opts.startRequest.gameName);
		const spectatorDir = path.join(this.instanceDir, 'spectator');
		await fs.mkdir(spectatorDir, { recursive: true });

		const script = tdf.serialize({
			GAME: {
				HostIP: this.opts.spectatorClient.hostIP,
				HostPort: this.opts.hostPort,
				GameType: this.opts.startRequest.gameName,
				MyPlayerName: this.opts.spectatorClient.name,
				MyPasswd: this.opts.spectatorClient.password,
				IsHost: 0,
			},
		});
		const scriptPath = path.join(spectatorDir, 'script.txt');
		await fs.writeFile(scriptPath, script);

		const spectatorBinPath = await this.resolveSpectatorBinary(engineDir);

		this.spectatorProcess = (this.env.mocks?.spawn ?? spawn)(
			spectatorBinPath,
			[scriptPath],
			{
				cwd: spectatorDir,
				stdio: 'ignore',
				env: {
					...process.env,
					// Share the same data directories as the host so spectator can find
					// game/map content downloaded by pr-downloader in the working directory.
					SPRING_DATADIR: path.resolve('.'),
					SPRING_WRITEDIR: spectatorDir,
				},
			},
		);

		this.spectatorProcess.on('spawn', () => {
			this.spectatorSpawned = true;
			if (this.state == State.Stopping) {
				this.killSpectator();
			}
		});

		this.spectatorProcess.on('error', (err) => {
			if (!this.spectatorSpawned) {
				this.spectatorProcess = null;
				this.maybeEmitExit();
			}
			this.logger.warn(err, 'spectator sidecar process errored');
		});

		this.spectatorProcess.on('exit', (code, signal) => {
			this.spectatorProcess = null;
			if (this.state < State.Stopping && code !== 0) {
				this.logger.warn(
					{ code, signal },
					'spectator sidecar exited unexpectedly, continuing battle',
				);
			}
			this.maybeEmitExit();
		});
	}

	private async resolveSpectatorBinary(engineDir: string): Promise<string> {
		const headlessPath = path.join(engineDir, engineHeadlessBinaryName());
		if (await fs.stat(headlessPath).catch(() => null)) {
			return headlessPath;
		}

		return path.join(engineDir, engineClientBinaryName());
	}

	private async ensureGameContent(engineDir: string, gameName: string): Promise<void> {
		if (!gameName.includes(':')) {
			return;
		}

		const prDownloaderPath = path.join(
			engineDir,
			process.platform === 'win32' ? 'pr-downloader.exe' : 'pr-downloader',
		);
		if (!(await fs.stat(prDownloaderPath).catch(() => null))) {
			this.logger.warn({ prDownloaderPath }, 'pr-downloader not found, skipping game download');
			return;
		}

		const maxAttempts = Math.max(1, this.env.config.engineDownloadMaxAttempts ?? 2);
		const backoffBaseMs = Math.max(1, this.env.config.engineDownloadRetryBackoffBaseMs ?? 1000);
		const timeoutMs = Math.max(5000, (this.env.config.engineInstallTimeoutSeconds ?? 600) * 1000);

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await this.runPrDownloader(prDownloaderPath, gameName, timeoutMs);
				return;
			} catch (err) {
				if (attempt === maxAttempts) {
					throw err;
				}
				const backoffMs = backoffBaseMs * Math.pow(2, attempt - 1);
				this.logger.warn(
					{ err, gameName, attempt, maxAttempts, backoffMs },
					'game download failed, retrying',
				);
				await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
			}
		}
	}

	private async runPrDownloader(
		prDownloaderPath: string,
		gameName: string,
		timeoutMs: number,
	): Promise<void> {
		const searchUrl = new URL(
			'/find',
			this.env.config.engineCdnBaseUrl ?? 'https://files-cdn.beyondallreason.dev',
		).toString();
		const repoMasterUrl =
			this.env.config.rapidRepoMasterUrl ?? 'https://repos-cdn.beyondallreason.dev/repos.gz';

		try {
			await this.runPrDownloaderOnce(prDownloaderPath, gameName, timeoutMs, repoMasterUrl, searchUrl);
		} catch (err) {
			if (!isTlsCertError(err)) {
				throw err;
			}

			const insecureRepoMasterUrl = forceHttpUrl(repoMasterUrl);
			const insecureSearchUrl = forceHttpUrl(searchUrl);
			if (!insecureRepoMasterUrl || !insecureSearchUrl) {
				throw err;
			}

			this.logger.warn(
				{ repoMasterUrl, searchUrl },
				'pr-downloader TLS CA error detected, retrying game download over HTTP',
			);
			await this.runPrDownloaderOnce(
				prDownloaderPath,
				gameName,
				timeoutMs,
				insecureRepoMasterUrl,
				insecureSearchUrl,
			);
		}
	}

	private async runPrDownloaderOnce(
		prDownloaderPath: string,
		gameName: string,
		timeoutMs: number,
		repoMasterUrl: string,
		searchUrl: string,
	): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const args = ['--filesystem-writepath', path.resolve('.'), '--download-game', gameName];
			const pr = (this.env.mocks?.spawn ?? spawn)(prDownloaderPath, args, {
				env: {
					...process.env,
					// Point bundled libcurl at the system CA bundle so HTTPS works
					// in minimal container images (e.g. bookworm-slim).

					PRD_RAPID_USE_STREAMER: 'false',
					PRD_RAPID_REPO_MASTER: repoMasterUrl,
					PRD_HTTP_SEARCH_URL: searchUrl,
				},
				stdio: ['ignore', 'ignore', 'pipe'],
			});

			let stderr = '';
			pr.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString();
			});

			const timeout = setTimeout(() => {
				pr.kill('SIGKILL');
				reject(new Error(`pr-downloader timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			pr.on('error', (err) => {
				clearTimeout(timeout);
				reject(err);
			});

			pr.on('exit', (code, signal) => {
				clearTimeout(timeout);
				if (code === 0) {
					resolve();
					return;
				}
				reject(
					new Error(
						`pr-downloader exited with code ${code}, signal ${signal}${stderr ? `: ${stderr.trim()}` : ''}`,
					),
				);
			});
		});
	}

	private async startEngine(
		instanceDir: string,
		startRequest: AutohostStartRequestData,
	): Promise<void> {
		const engineDir = path.resolve('engines', startRequest.engineVersion);
		if (!(await fs.stat(engineDir).catch(() => null))) {
			throw new TachyonError<'autohost/start'>(
				'engine_version_not_available',
				`engine version ${startRequest.engineVersion} not available exist`,
			);
		}

		if (this.state != State.Starting) return;

		this.engineProcess = (this.env.mocks?.spawn ?? spawn)(
			path.join(engineDir, engineBinaryName()),
			['-isolation', path.join(instanceDir, 'script.txt')],
			{
				cwd: instanceDir,
				stdio: 'ignore',
				env: {
					...process.env,
					'SPRING_WRITEDIR': instanceDir,
				},
			},
		);
		this.engineProcess.on('error', (err) => {
			if (!this.engineSpawned) {
				this.engineProcess = null;
				this.maybeEmitExit();
			}
			this.handleError(err);
		});
		this.engineProcess.on('spawn', () => {
			this.engineSpawned = true;
			if (this.state == State.Stopping) {
				this.killEngine();
			}
		});
		this.engineProcess.on('exit', (code, signal) => {
			this.engineProcess = null;
			if (code !== 0) {
				this.handleError(new Error(`Engine exited with code ${code}, signal ${signal}`));
			} else {
				this.close();
			}
			this.maybeEmitExit();
		});
	}

	/**
	 * Setup the game instance directory for the engine.
	 *
	 * The instance directory is the data write directory for the engine and
	 * contains start script, settings, it's also where the demo and other
	 * files are written.
	 */
	private async setupInstanceDir(opts: Opts): Promise<string> {
		let game;
		try {
			game = scriptGameFromStartRequest(opts.startRequest);
		} catch (err) {
			if (err instanceof StartScriptGenError) {
				throw new TachyonError('invalid_request', `invalid start script: ${err.message}`);
			}
			throw err;
		}
		game['IsHost'] = 1;
		game['HostIP'] = opts.hostIP;
		game['HostPort'] = opts.hostPort;
		game['AutohostIP'] = '127.0.0.1';
		game['AutohostPort'] = opts.autohostPort;
		const script = tdf.serialize({ 'GAME': game });

		const instanceDir = path.resolve('instances', opts.startRequest.battleId);
		await fs.mkdir(instanceDir, { recursive: true });
		const scriptPath = path.join(instanceDir, 'script.txt');
		await fs.writeFile(scriptPath, script);

		const engineSettings = serializeEngineSettings({
			...this.env.config.engineSettings,
			// Needed by the logic in autohost: currently it doesn't properly
			// handle player number mapping if we allow anonymous spectators.
			'AllowSpectatorJoin': '0',
			// We always want to allow players to be added when the controlling
			// server requests it.
			'WhiteListAdditionalPlayers': '1',
		});
		await fs.writeFile(path.join(instanceDir, 'springsettings.cfg'), engineSettings);

		return instanceDir;
	}
}

function forceHttpUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') {
			return null;
		}
		parsed.protocol = 'http:';
		return parsed.toString();
	} catch {
		return null;
	}
}

function isTlsCertError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	const msg = err.message.toLowerCase();
	return (
		msg.includes('ssl ca cert') ||
		msg.includes('ssl peer certificate') ||
		msg.includes('certificate verify failed') ||
		msg.includes('curl error(1:77)') ||
		msg.includes('curl error(1:60)')
	);
}

/**
 * Run the engine with the given options
 *
 * @param opts Options for the engine runner
 * @returns The engine runner instance
 * @throws {never} `error` event is emitted from returned object if an error occurs
 */
export function runEngine(env: Env, opts: Opts): EngineRunner {
	const runner = new EngineRunnerImpl(env);
	runner._run(opts);
	return runner;
}
