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
writeFileSync(path.join(root, 'package.json'), JSON.stringify({scripts: {test: 'node --test "t/*.test.ts"', typecheck: 'tsc --noEmit'}}));
mkdirSync(path.join(root, 'node_modules', 'typescript', 'bin'), {recursive: true});
writeFileSync(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '');
writeFileSync(path.join(root, 'modules', 'a', 'package.json'), JSON.stringify({scripts: {test: 'node --test "t/*.test.ts"', typecheck: 'tsc -p .'}}));

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

test('dev and dev help show the help through ctx.showHelp, or print the usage without it', async () => {
	const command = createDevCommand({root, loadUi: noUi, spawn});
	for (const args of [[], ['help']]) {
		let shown = 0;
		const withHelp = context({showHelp: () => void shown++});
		await command.run(args, withHelp.ctx);
		assert.equal(shown, 1);
		assert.deepEqual(withHelp.printed, []);
		const {printed, ctx} = context();
		await command.run(args, ctx);
		assert.deepEqual(printed, ['dev <subcommand>']);
	}
});

test('unknown subcommands and extra arguments are usage errors', async () => {
	const command = createDevCommand({root, loadUi: noUi, spawn});
	await assert.rejects(async () => command.run(['nope'], context().ctx), {message: 'Unknown subcommand: nope. Usage: dev test|typecheck|check [suite…] [--file <path>]… [--name <pattern>]'});
	await assert.rejects(async () => command.run(['test', '--bogus'], context().ctx), {message: 'Unknown option: --bogus'});
	await assert.rejects(async () => command.run(['typecheck', '--name', 'x'], context().ctx), /apply to tests/);
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
	await assert.rejects(async () => command.run(['test'], context().ctx), {message: 'A dev run is already in progress'});
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

const isTsc = (args: string[]): boolean => args[0]?.endsWith('tsc') === true;
const failingTsc: SpawnFn = async (args, options) => {
	if (!isTsc(args)) return spawn(args, options);
	options.onLine('a.ts(1,1): error TS1005: oops');
	return {...done, code: 2};
};

test('typecheck prints one line per suite and a summary', async () => {
	const command = createDevCommand({root, loadUi: noUi, spawn: async () => done});
	const {printed, ctx} = context();
	await command.run(['typecheck'], ctx);
	assert.match(printed[0] as string, /^Typechecking 2 suites/);
	assert.match(printed[1] as string, /^✔ host typecheck · /);
	assert.match(printed.at(-1) as string, /^Typecheck: 2\/2 passed · 0 failed · /);
});

test('check runs the tests only after a passing typecheck', async () => {
	const order: string[] = [];
	const tracking: SpawnFn = async (args, options) => {
		order.push(isTsc(args) ? 'tsc' : 'test');
		return spawn(args, options);
	};
	const command = createDevCommand({root, loadUi: noUi, spawn: tracking});
	const {printed, ctx} = context();
	await command.run(['check', 'a'], ctx);
	assert.equal(order[0], 'tsc');
	assert.ok(order.includes('test'));
	assert.match(printed.at(-1) as string, /^Tests: 2\/2 passed/);

	order.length = 0;
	const failing = createDevCommand({root, loadUi: noUi, spawn: failingTsc});
	const second = context();
	await failing.run(['check', 'a'], second.ctx);
	assert.match(second.printed.join('\n'), /Tests skipped: the typecheck did not pass/);
	assert.ok(!second.printed.join('\n').includes('Running'));
});

test('headless failures throw after the summary, the UI keeps printing only', async () => {
	const command = createDevCommand({root, loadUi: noUi, spawn: failingTsc});
	const headless = context({headless: true});
	await assert.rejects(async () => command.run(['typecheck', 'a'], headless.ctx), {message: '1 suite failed'});
	assert.match(headless.printed.at(-1) as string, /^Typecheck: 0\/1 passed · 1 failed/);
	const ui = context();
	await command.run(['typecheck', 'a'], ui.ctx);

	const failingTest: SpawnFn = async (args, options) => (args.some(a => a.endsWith('discover.ts')) ? spawn(args, options) : {...done, code: 1});
	const tests = createDevCommand({root, loadUi: noUi, spawn: failingTest});
	const run = context({headless: true});
	await assert.rejects(async () => tests.run(['test', 'a'], run.ctx), /suites? failed$/);
	assert.match(run.printed.at(-1) as string, /^Tests:/);
	await tests.run(['test', 'a'], context().ctx);

	await assert.rejects(async () => command.run(['check', 'a'], context({headless: true}).ctx), {message: '1 suite failed'});
	await createDevCommand({root, loadUi: noUi, spawn}).run(['test', 'a'], context({headless: true}).ctx);
});

test('signal handlers exist only during a headless run and abort it', async () => {
	const counts = (): number[] => ['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listenerCount(s));
	const before = counts();
	let during: number[] = [];
	let sawAbort = false;
	const watching: SpawnFn = async (args, options) => {
		if (!isTsc(args)) return spawn(args, options);
		during = counts();
		process.emit('SIGHUP');
		sawAbort = options.signal?.aborted === true;
		return {...done, code: null, aborted: true};
	};
	const command = createDevCommand({root, loadUi: noUi, spawn: watching});
	await assert.rejects(async () => command.run(['typecheck', 'a'], context({headless: true}).ctx), /failed$/);
	assert.deepEqual(during, before.map(n => n + 1));
	assert.equal(sawAbort, true);
	assert.deepEqual(counts(), before);

	let uiDuring: number[] = [];
	const uiWatch: SpawnFn = async () => {
		uiDuring = counts();
		return done;
	};
	await createDevCommand({root, loadUi: noUi, spawn: uiWatch}).run(['typecheck', 'a'], context().ctx);
	assert.deepEqual(uiDuring, before);
});

test('the run lock is shared by typecheck and check and released after a refused or failed start', async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>(resolve => (release = resolve));
	const slow: SpawnFn = async (args, options) => {
		await gate;
		return spawn(args, options);
	};
	const command = createDevCommand({root, loadUi: noUi, spawn: slow});
	const first = command.run(['typecheck', 'a'], context().ctx);
	for (const sub of ['test', 'check', 'typecheck']) {
		await assert.rejects(async () => command.run([sub, 'a'], context().ctx), {message: 'A dev run is already in progress'}, sub);
	}
	release();
	await Promise.resolve(first).catch(() => undefined);
	await assert.rejects(async () => command.run(['typecheck', 'nope'], context().ctx), /Unknown test suite/);
	await assert.rejects(async () => command.run(['check', 'nope'], context().ctx), /Unknown test suite/);
});

test('each subcommand shows its own usage', () => {
	const usages = createDevCommand({root, loadUi: noUi, spawn}).subcommands!.map(s => s.usage);
	assert.deepEqual(usages, [
		'dev test [suite…] [--file <path>]… [--name <pattern>]',
		'dev typecheck [suite…]',
		'dev check [suite…] [--file <path>]… [--name <pattern>]',
	]);
});

test('several suites run in one go, in suite order', async () => {
	const cwds: string[] = [];
	const tracking: SpawnFn = async (args, options) => {
		if (!args.some(a => a.endsWith('discover.ts'))) cwds.push(options.cwd);
		return spawn(args, options);
	};
	const command = createDevCommand({root, loadUi: noUi, spawn: tracking});
	await command.run(['test', 'a', 'host', 'a'], context().ctx);
	assert.deepEqual(cwds, [root, path.join(root, 'modules', 'a')]);
});

test('--file runs only the given files in the suite that holds them, --name filters by test name', async () => {
	mkdirSync(path.join(root, 'modules', 'a', 't'), {recursive: true});
	writeFileSync(path.join(root, 'modules', 'a', 't', 'one.test.ts'), '');
	const runs: {cwd: string; args: string[]}[] = [];
	let discovered = 0;
	const tracking: SpawnFn = async (args, options) => {
		if (args.some(a => a.endsWith('discover.ts'))) discovered++;
		else runs.push({cwd: options.cwd, args});
		return spawn(args, options);
	};
	const command = createDevCommand({root, loadUi: noUi, spawn: tracking});
	await command.run(['test', '--file', 'modules/a/t/one.test.ts'], context().ctx);
	assert.equal(runs.length, 1);
	assert.equal(runs[0]!.cwd, path.join(root, 'modules', 'a'));
	assert.deepEqual(runs[0]!.args.slice(-1), [path.join('t', 'one.test.ts')]);
	assert.ok(!runs[0]!.args.includes('t/*.test.ts'));

	runs.length = 0;
	await command.run(['test', 'a', '--file=t/one.test.ts', '--name', 'only this'], context().ctx);
	assert.ok(runs[0]!.args.includes('--test-name-pattern=only this'));
	assert.equal(discovered, 1);

	await assert.rejects(async () => command.run(['test', 'host', '--file', 'modules/a/t/one.test.ts'], context().ctx), {message: 'modules/a/t/one.test.ts is not in suite host'});
	await assert.rejects(async () => command.run(['test', '--file', 'nope.test.ts'], context().ctx), {message: 'No such test file: nope.test.ts'});
	await assert.rejects(async () => command.run(['test', '--file', 'package.json'], context().ctx), {message: 'Not a test file: package.json'});
});

test('runs through the console bridge (ctx.signal) print the summary without bars', async () => {
	const command = createDevCommand({root, loadUi: noUi, spawn});
	const bridged = context({signal: new AbortController().signal});
	await command.run(['test', 'a'], bridged.ctx);
	const plain = context();
	await command.run(['test', 'a'], plain.ctx);
	const braille = /[\u2800-\u28ff]/;
	assert.ok(!braille.test(bridged.printed.at(-1) as string));
	assert.ok(braille.test(plain.printed.at(-1) as string));
});

test('a root given as a function is asked on every run, and its error ends the run cleanly', async () => {
	let calls = 0;
	let fail = true;
	const command = createDevCommand({
		root: () => {
			calls++;
			if (fail) throw new Error('No yena working copy in /workplace/yena');
			return root;
		},
		loadUi: noUi,
		spawn,
	});
	await assert.rejects(async () => command.run(['test', 'a'], context().ctx), /No yena working copy in \/workplace\/yena/);
	fail = false;
	const {printed, ctx} = context();
	await command.run(['test', 'a'], ctx);
	assert.equal(calls, 2);
	assert.match(printed.at(-1) as string, /^Tests: 2\/2 passed/);
});
