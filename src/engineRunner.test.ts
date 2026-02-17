// SPDX-FileCopyrightText: 2025 The Recoil Autohost Authors
//
// SPDX-License-Identifier: Apache-2.0

import test, { suite } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import events from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { AutohostStartRequestData } from 'tachyon-protocol/types';
import { setImmediate as asyncSetImmediate, setTimeout as asyncSetTimeout } from 'timers/promises';

import { runEngine, EngineRunnerImpl } from './engineRunner.js';
import { chdir } from 'node:process';
import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { pino } from 'pino';
import { EventType } from './engineAutohostInterface.js';

// Find a free port to use for testing
const tmpSock = dgram.createSocket('udp4').bind(0, '127.0.0.1');
await events.once(tmpSock, 'listening');
const testPort = tmpSock.address().port;
tmpSock.close();

// The contents of this except for the gameUUID doesn't matter much
// unit tests don't execute the real engine.
const demoStartRequest: AutohostStartRequestData = {
	battleId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
	engineVersion: 'test',
	mapName: 'map v1',
	gameName: 'mod v1',
	startPosType: 'fixed',
	allyTeams: [
		{
			teams: [
				{
					players: [
						{
							userId: '441a8dde-4a7a-4baf-9a3f-f51015fa61c4',
							name: 'Player X',
							password: 'X',
							countryCode: 'DE',
						},
					],
				},
			],
		},
	],
};

const optsBase = {
	startRequest: demoStartRequest,
	hostIP: '127.0.0.1',
	hostPort: 8452,
	autohostPort: testPort,
};

function getEnv(spawnMock?: typeof spawn) {
	return {
		logger: pino({ level: 'silent' }),
		config: { engineSettings: {} },
		mocks: { spawn: spawnMock },
	};
}

const origCwd = process.cwd();
let testDir: string;

suite('engineRunner', () => {
	test.beforeEach(async () => {
		testDir = await mkdtemp(path.join(tmpdir(), 'engine-runner-test-'));
		chdir(testDir);
		await mkdir('engines/test', { recursive: true });
	});

	test.afterEach(async () => {
		chdir(origCwd);
		await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	test('runEngine quick close works', async () => {
		const er = runEngine(getEnv(), optsBase);
		er.close();
		await events.once(er, 'exit');
	});

	test('engineRunner emits error on server start', async () => {
		const er = new EngineRunnerImpl(
			getEnv((() => {
				const cp = new ChildProcess();
				process.nextTick(() => {
					cp.emit('error', new Error('test error'));
				});
				return cp;
			}) as typeof spawn),
		);
		er._run(optsBase);
		await assert.rejects(events.once(er, 'start'), /test error/);
	});

	test('engineRunner spawns process correctly', async () => {
		const er = new EngineRunnerImpl(
			getEnv(((cmd: string, args: string[], opts: SpawnOptions) => {
				assert.match(cmd, /[\\/]engines[\\/]test[\\/]spring-dedicated(\.exe)?$/);
				return spawn('echo', args, opts);
			}) as typeof spawn),
		);
		er._run(optsBase);
		await events.once(er, 'exit');
	});

	test('engineRunner close before spawn works', async () => {
		const er = new EngineRunnerImpl(
			getEnv((() => {
				process.nextTick(() => {
					er.close();
				});
				return spawn('sleep', ['1000'], { stdio: 'ignore' });
			}) as typeof spawn),
		);
		er._run(optsBase);
		await events.once(er, 'exit');
	});

	test('engineRunner multi start, multi close', async () => {
		const er = new EngineRunnerImpl(getEnv());
		er._run(optsBase);
		assert.throws(() => er._run(optsBase));
		er.close();
		er.close();
		await events.once(er, 'exit');
	});

	test('engineRunner full run simulated engine', async () => {
		const er = new EngineRunnerImpl(
			getEnv((() => {
				const cp = new ChildProcess();

				cp.kill = (() => {
					assert.fail('kill should not be called');
				}) as typeof ChildProcess.prototype.kill;

				process.nextTick(() => {
					cp.emit('spawn');
				});

				setImmediate(() => simulateEngine(cp));

				return cp;
			}) as typeof spawn),
		);
		er._run(optsBase);

		async function simulateEngine(cp: ChildProcess) {
			const s = dgram.createSocket('udp4');
			s.connect(testPort);
			await events.once(s, 'connect');

			for (const packet of [
				Buffer.from('00', 'hex'),
				Buffer.from('054f6e6c696e65207761726e696e67206c6f6c', 'hex'),
				Buffer.from('14320c000a640000407a683630', 'hex'),
				Buffer.from('01', 'hex'),
			]) {
				await asyncSetImmediate();
				s.send(packet);
				// 0x14 -> luamsg, filtered out by default.
				if (packet[0] != 0x14) {
					const msg = (await events.once(s, 'message')) as [Buffer, dgram.RemoteInfo];
					assert.equal(msg[0].toString('utf8'), `test${packet[0]}`);
				}
			}

			await asyncSetImmediate();
			cp.emit('exit', 0, 'exit');
			s.close();
		}

		assert.rejects(er.sendPacket(Buffer.from('asd')), /not running/);

		er.on('packet', async (packet) => {
			await er.sendPacket(Buffer.from(`test${packet.type}`));
		});

		await events.once(er, 'start');
		await events.once(er, 'exit');
	});

	test('emit only luamsg matching regex', async () => {
		const er = new EngineRunnerImpl(
			getEnv((() => {
				const cp = new ChildProcess();
				process.nextTick(() => cp.emit('spawn'));
				setImmediate(() => simulateEngine(cp));
				return cp;
			}) as typeof spawn),
		);
		er._run({
			...optsBase,
			startRequest: {
				...demoStartRequest,
				luamsgRegexp: '^id:',
			},
		});

		const { promise: receivedAll, resolve: receivedAllResolve } = Promise.withResolvers();
		let expectedPackets = 4;

		async function simulateEngine(cp: ChildProcess) {
			const s = dgram.createSocket('udp4');
			s.connect(testPort);
			await events.once(s, 'connect');

			for (const packet of [
				Buffer.from('00', 'hex'),
				Buffer.from('14320c000a64000069643a6173', 'hex'),
				Buffer.from('14320c000a64000078783a7878', 'hex'),
				Buffer.from('14320c000a64000069643a786e', 'hex'),
				Buffer.from('14320c000a64000069643affff', 'hex'),
			]) {
				s.send(packet);
			}
			await receivedAll;
			cp.emit('exit', 0, 'exit');
			s.close();
		}

		assert.rejects(er.sendPacket(Buffer.from('asd')), /not running/);

		const packetsData: Buffer[] = [];
		er.on('packet', (packet) => {
			if (packet.type == EventType.GAME_LUAMSG) {
				packetsData.push(packet.data);
			}
			if (--expectedPackets == 0) {
				receivedAllResolve(undefined);
			}
		});

		await events.once(er, 'exit');

		assert.deepEqual(packetsData, [
			Buffer.from('id:as'),
			Buffer.from('id:xn'),
			Buffer.from('69643affff', 'hex'),
		]);
	});

	test('spawns spectator sidecar for bot-only load mode', async () => {
		const hostCp = new ChildProcess();
		const spectatorCp = new ChildProcess();
		spectatorCp.kill = (() => {
			process.nextTick(() => spectatorCp.emit('exit', 0, 'SIGTERM'));
			return true;
		}) as typeof ChildProcess.prototype.kill;
		hostCp.kill = (() => {
			process.nextTick(() => hostCp.emit('exit', 0, 'SIGTERM'));
			return true;
		}) as typeof ChildProcess.prototype.kill;

		const spawnCalls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
		const er = new EngineRunnerImpl(
			getEnv(((cmd: string, args: string[], opts: SpawnOptions) => {
				spawnCalls.push({ cmd, args, opts });
				if (spawnCalls.length === 1) {
					process.nextTick(() => hostCp.emit('spawn'));
					return hostCp;
				}
				process.nextTick(() => spectatorCp.emit('spawn'));
				return spectatorCp;
			}) as typeof spawn),
		);

		er._run({
			...optsBase,
			spectatorClient: {
				hostIP: '127.0.0.1',
				name: 'autohost-bot-spectator',
				password: 'test-pass',
			},
		});

		const s = dgram.createSocket('udp4');
		try {
			s.connect(testPort);
			await events.once(s, 'connect');
			const serverStartedPacket = Buffer.from('00', 'hex');
			const sender = setInterval(() => {
				s.send(serverStartedPacket);
			}, 5);
			await events.once(er, 'start');
			clearInterval(sender);

			for (let i = 0; i < 50 && spawnCalls.length < 2; i++) {
				await asyncSetTimeout(10);
			}

			assert.equal(spawnCalls.length, 2);
			const sidecarScriptPath = spawnCalls[1].args[0];
			assert.match(sidecarScriptPath, /[\\/]instances[\\/].*[\\/]spectator[\\/]script\.txt$/);
			const sidecarScript = await readFile(sidecarScriptPath, 'utf-8');
			assert.match(sidecarScript, /\bIsHost\s*=\s*0\b/);
			assert.match(sidecarScript, /\bGameType\s*=\s*mod v1\b/);
			assert.match(sidecarScript, /\bMyPlayerName\s*=\s*autohost-bot-spectator\b/);
			assert.match(sidecarScript, /\bMyPasswd\s*=\s*test-pass\b/);
		} finally {
			er.close();
			await events.once(er, 'exit');
			s.close();
		}
	});

	test('downloads rapid game content before spectator spawn', async () => {
		const prDownloaderName = process.platform === 'win32' ? 'pr-downloader.exe' : 'pr-downloader';
		await writeFile(path.join(testDir, 'engines', 'test', prDownloaderName), 'fake-binary');

		const hostCp = new ChildProcess();
		const prDownloaderCp = new ChildProcess();
		const spectatorCp = new ChildProcess();
		spectatorCp.kill = (() => {
			process.nextTick(() => spectatorCp.emit('exit', 0, 'SIGTERM'));
			return true;
		}) as typeof ChildProcess.prototype.kill;
		hostCp.kill = (() => {
			process.nextTick(() => hostCp.emit('exit', 0, 'SIGTERM'));
			return true;
		}) as typeof ChildProcess.prototype.kill;

		const spawnCalls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
		const er = new EngineRunnerImpl(
			getEnv(((cmd: string, args: string[], opts: SpawnOptions) => {
				spawnCalls.push({ cmd, args, opts });
				const cmdName = path.basename(cmd);
				if (cmdName === prDownloaderName) {
					process.nextTick(() => {
						prDownloaderCp.emit('spawn');
						prDownloaderCp.emit('exit', 0, null);
					});
					return prDownloaderCp;
				}
				if (spawnCalls.length === 1) {
					process.nextTick(() => hostCp.emit('spawn'));
					return hostCp;
				}
				process.nextTick(() => spectatorCp.emit('spawn'));
				return spectatorCp;
			}) as typeof spawn),
		);

		er._run({
			...optsBase,
			startRequest: {
				...optsBase.startRequest,
				gameName: 'byar:test',
			},
			spectatorClient: {
				hostIP: '127.0.0.1',
				name: 'autohost-bot-spectator',
				password: 'test-pass',
			},
		});

		const s = dgram.createSocket('udp4');
		try {
			s.connect(testPort);
			await events.once(s, 'connect');
			const serverStartedPacket = Buffer.from('00', 'hex');
			const sender = setInterval(() => {
				s.send(serverStartedPacket);
			}, 5);
			await events.once(er, 'start');
			clearInterval(sender);

			for (let i = 0; i < 50 && spawnCalls.length < 3; i++) {
				await asyncSetTimeout(10);
			}

			assert.equal(spawnCalls.length, 3);
			assert.match(spawnCalls[1].cmd, new RegExp(`${prDownloaderName.replace('.', '\\.')}$`));
			assert.deepEqual(spawnCalls[1].args, [
				'--filesystem-writepath',
				testDir,
				'--download-game',
				'byar:test',
			]);
		} finally {
			er.close();
			await events.once(er, 'exit');
			s.close();
		}
	});

	test('falls back to http on pr-downloader TLS cert errors', async () => {
		const prDownloaderName = process.platform === 'win32' ? 'pr-downloader.exe' : 'pr-downloader';
		await writeFile(path.join(testDir, 'engines', 'test', prDownloaderName), 'fake-binary');

		const hostCp = new ChildProcess();
		const prDownloaderCp1 = new ChildProcess();
		const prDownloaderCp2 = new ChildProcess();
		const spectatorCp = new ChildProcess();
		spectatorCp.kill = (() => {
			process.nextTick(() => spectatorCp.emit('exit', 0, 'SIGTERM'));
			return true;
		}) as typeof ChildProcess.prototype.kill;
		hostCp.kill = (() => {
			process.nextTick(() => hostCp.emit('exit', 0, 'SIGTERM'));
			return true;
		}) as typeof ChildProcess.prototype.kill;

		const spawnCalls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
		const er = new EngineRunnerImpl(
			getEnv(((cmd: string, args: string[], opts: SpawnOptions) => {
				spawnCalls.push({ cmd, args, opts });
				const cmdName = path.basename(cmd);
				if (cmdName === prDownloaderName) {
					if (spawnCalls.length === 2) {
						process.nextTick(() => {
							prDownloaderCp1.emit(
								'error',
								new Error('CURL error(1:77): Problem with the SSL CA cert'),
							);
						});
						return prDownloaderCp1;
					}
					process.nextTick(() => {
						prDownloaderCp2.emit('spawn');
						prDownloaderCp2.emit('exit', 0, null);
					});
					return prDownloaderCp2;
				}
				if (spawnCalls.length === 1) {
					process.nextTick(() => hostCp.emit('spawn'));
					return hostCp;
				}
				process.nextTick(() => spectatorCp.emit('spawn'));
				return spectatorCp;
			}) as typeof spawn),
		);

		er._run({
			...optsBase,
			startRequest: {
				...optsBase.startRequest,
				gameName: 'byar:test',
			},
			spectatorClient: {
				hostIP: '127.0.0.1',
				name: 'autohost-bot-spectator',
				password: 'test-pass',
			},
		});

		const s = dgram.createSocket('udp4');
		try {
			s.connect(testPort);
			await events.once(s, 'connect');
			const serverStartedPacket = Buffer.from('00', 'hex');
			const sender = setInterval(() => {
				s.send(serverStartedPacket);
			}, 5);
			await events.once(er, 'start');
			clearInterval(sender);

			for (let i = 0; i < 50 && spawnCalls.length < 4; i++) {
				await asyncSetTimeout(10);
			}

			assert.equal(spawnCalls.length, 4);
			assert.equal(spawnCalls[1].opts.env?.PRD_RAPID_REPO_MASTER, 'https://repos-cdn.beyondallreason.dev/repos.gz');
			assert.equal(spawnCalls[2].opts.env?.PRD_RAPID_REPO_MASTER, 'http://repos-cdn.beyondallreason.dev/repos.gz');
		} finally {
			er.close();
			await events.once(er, 'exit');
			s.close();
		}
	});
});
