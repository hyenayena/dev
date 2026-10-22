import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import type {CommandContext, MountControl} from '../../../src/api.js';
import {createDevCommand, type DevUi} from '../src/commands.js';
import type {SpawnFn} from '../src/spawn.js';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dev-commands-')));
after(() => rmSync(root, {recursive: true, force: true}));
mkdirSync(path.join(root, 'modules', 'a'), {recursive: true});
writeFileSync(path.join(root, 'package.json'), JSON.stringify({scripts: {test: 'node --test "t/*.test.ts"'}}));
writeFileSync(path.join(root, 'modules', 'a', 'package.json'), JSON.stringify({scripts: {test: 'node --test "t/*.test.ts"'}}));

const done = {code: 0, signal: null, stderr: '', timedOut: false, aborted: false};
const line = (kind: string): string => JSON.stringify({dev: 1, kind, name: 'x', file: 'f', ms: 1});

const spawn: SpawnFn = async (args, options) => {
	if (args.some(a => a.endsWith('discover.ts'))) options.onLine(JSON.stringify({dev: 1, kind: 'discovered', total: 2, files: 1}));
	else {
		options.onLine(line('pass'));
		options.onLine(line('pass'));
	}
	return done;
};

const noUi = (): Promise<DevUi> => Promise.reject(new Error('the UI must not load'));

function context(extra: Partial<CommandContext> = {}) {
	const printed: string[] = [];
	const ctx: CommandContext = {print: t => void printed.push(t), clear: () => {}, exit: () => {}, ...extra};
	return {printed, ctx};
}

test('dev and dev help print the usage', async () => {
	const command = createDevCommand({root, loadUi: noUi, spawn});
	for (const args of [[], ['help']]) {
		const {printed, ctx} = context();
		await command.run(args, ctx);
		assert.match(printed.join('\n'), /Usage: dev test \[suite\]/);
	}
});

test('unknown subcommands and extra arguments are usage errors', async () => {
	const command = createDevCommand({root, loadUi: noUi, spawn});
	await assert.rejects(async () => command.run(['nope'], context().ctx), {message: 'Unknown subcommand: nope. Usage: dev test [suite]'});
	await assert.rejects(async () => command.run(['test', 'a', 'b'], context().ctx), /Usage: dev test \[suite\]/);
	await assert.rejects(async () => command.run(['test', 'zzz'], context().ctx), {message: 'Unknown test suite: zzz. Known: host, a'});
});

test('without mount the summary is printed at the end', async () => {
	const command = createDevCommand({root, loadUi: noUi, spawn});
	const {printed, ctx} = context();
	await command.run(['test', 'a'], ctx);
	assert.match(printed[0] as string, /^Running 1 test suite/);
	assert.match(printed.at(-1) as string, /^Tests: 2\/2 passed · 0 failed · 0 skipped/);
});

test('a second run while one is active is refused', async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>(resolve => (release = resolve));
	const slow: SpawnFn = async (args, options) => {
		await gate;
		return spawn(args, options);
	};
	const command = createDevCommand({root, loadUi: noUi, spawn: slow});
	const first = command.run(['test', 'a'], context().ctx);
	await assert.rejects(async () => command.run(['test'], context().ctx), {message: 'A test run is already in progress'});
	release();
	await first;
	await command.run(['test', 'a'], context().ctx);
});

test('with mount the view goes to the panel, is closed after the run and the summary follows', async () => {
	const events: string[] = [];
	let finishMount: () => void = () => {};
	const control: MountControl = {
		close: () => {
			events.push('close');
			finishMount();
		},
		host: {isFocused: () => true, columns: () => 40, subscribe: () => () => {}, move: () => false, isHostKey: () => false},
	};
	const ui: DevUi = {
		buildTestView: () => {
			events.push('build');
			return {};
		},
		color: () => false,
	};
	const command = createDevCommand({root, loadUi: async () => ui, spawn});
	const {printed, ctx} = context({
		mount: (build, options) => {
			events.push(`mount:${options?.target}`);
			build(control);
			return new Promise<void>(resolve => (finishMount = resolve));
		},
		print: t => void printed.push(t),
	});
	await command.run(['test', 'a'], ctx);
	assert.deepEqual(events, ['mount:panel', 'build', 'close']);
	assert.match(printed.at(-1) as string, /^Tests: 2\/2 passed/);
});

test('ctx.signal abort cancels the running tests and releases the lock', async () => {
	let aborted = false;
	let hung = false;
	let started: () => void = () => {};
	const running = new Promise<void>(resolve => (started = resolve));
	const waiting: SpawnFn = async (args, options) => {
		if (args.some(a => a.endsWith('discover.ts'))) return spawn(args, options);
		if (hung) return spawn(args, options);
		hung = true;
		started();
		await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), {once: true}));
		aborted = options.signal?.aborted === true;
		return {...done, aborted: true};
	};
	const command = createDevCommand({root, loadUi: noUi, spawn: waiting});
	const ac = new AbortController();
	const {printed, ctx} = context({signal: ac.signal});
	const run = command.run(['test', 'a'], ctx);
	await running;
	ac.abort();
	await run;
	assert.equal(aborted, true);
	assert.ok(printed.length > 0);
	await command.run(['test', 'a'], context().ctx);
});

test('an already aborted ctx.signal aborts before the tests start', async () => {
	let seen: boolean | undefined;
	const probe: SpawnFn = async (args, options) => {
		if (!args.some(a => a.endsWith('discover.ts'))) seen = options.signal?.aborted;
		return spawn(args, options);
	};
	const command = createDevCommand({root, loadUi: noUi, spawn: probe});
	const ac = new AbortController();
	ac.abort();
	await command.run(['test', 'a'], context({signal: ac.signal}).ctx);
	assert.notEqual(seen, false);
});

test('the abort listener is removed after the run', async () => {
	const added: string[] = [];
	const removed: string[] = [];
	const signal = {
		aborted: false,
		addEventListener: (t: string) => void added.push(t),
		removeEventListener: (t: string) => void removed.push(t),
	} as unknown as AbortSignal;
	const command = createDevCommand({root, loadUi: noUi, spawn});
	await command.run(['test', 'a'], context({signal}).ctx);
	assert.deepEqual(added, ['abort']);
	assert.deepEqual(removed, ['abort']);
});
