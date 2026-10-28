import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {parseDiscoveryLine, parseResultLine, runTests} from '../src/runner.js';
import {killAll, spawnNode, type SpawnFn, type SpawnOptions, type SpawnResult} from '../src/spawn.js';
import {createRunStore} from '../src/store.js';
import type {Suite} from '../src/suites.js';
import {alive, fixturesDir, waitGone} from './helpers.js';

const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'dev-runner-')));
after(() => rmSync(work, {recursive: true, force: true}));

const SCRIPT = 'node --import tsx --test "t/*.test.ts"';
const suite = (name: string, script = SCRIPT): Suite => ({name, dir: work, script});
const ok: SpawnResult = {code: 0, signal: null, stderr: '', timedOut: false, aborted: false};
const result = (kind: string, name = 'x', extra: object = {}): string => JSON.stringify({dev: 1, kind, name, file: 'f.ts', ms: 1, ...extra});

type Handler = (kind: 'discover' | 'run', suiteIndex: number, options: SpawnOptions) => Promise<SpawnResult> | SpawnResult;

function fakeSpawn(handler: Handler): SpawnFn {
	const seen = {discover: 0, run: 0};
	return async (args, options) => {
		const kind = args.some(a => a.endsWith('discover.ts')) ? 'discover' : 'run';
		return handler(kind, seen[kind]++, options);
	};
}

const discovered = (total: number): string => JSON.stringify({dev: 1, kind: 'discovered', total, files: 1});

test('parseResultLine never throws and ignores foreign lines', () => {
	for (const line of ['', 'garbage', '{', '{"dev":2,"kind":"pass"}', '{"dev":1,"kind":"nope"}', 'null', '[]', '{"kind":"pass"}']) {
		assert.equal(parseResultLine(line), undefined, line);
	}
	assert.equal(parseResultLine(result('pass', 'n'.repeat(900)))?.name.length, 500);
});

test('every total is in the store before the first test runs', async () => {
	const store = createRunStore();
	let plannedAtFirstRun: number[] = [];
	const spawn = fakeSpawn((kind, i, options) => {
		if (kind === 'discover') options.onLine(discovered(3 + i));
		else {
			if (i === 0) plannedAtFirstRun = store.get().suites.map(s => s.planned);
			for (let n = 0; n < 3 + i; n++) options.onLine(result('pass'));
		}
		return ok;
	});
	const outcome = await runTests({suites: [suite('a'), suite('b')], signal: new AbortController().signal, store, spawn});
	assert.deepEqual(plannedAtFirstRun, [3, 4]);
	assert.equal(outcome, 'ok');
	assert.equal(store.get().phase, 'done');
});

test('more results than planned grow the total, fewer leave a note', async () => {
	const store = createRunStore();
	const spawn = fakeSpawn((kind, i, options) => {
		if (kind === 'discover') options.onLine(discovered(2));
		else if (i === 0) for (let n = 0; n < 4; n++) options.onLine(result('pass'));
		else options.onLine(result('skip'));
		return ok;
	});
	await runTests({suites: [suite('a'), suite('b')], signal: new AbortController().signal, store, spawn});
	const [a, b] = store.get().suites;
	assert.equal(a?.planned, 4);
	assert.equal(b?.planned, 2);
	assert.equal(b?.note, '1 not run');
	assert.deepEqual(b?.states, ['skip']);
});

test('failed discovery makes the bar grow as results arrive', async () => {
	const store = createRunStore();
	const spawn = fakeSpawn((kind, _i, options) => {
		if (kind === 'discover') return {...ok, code: 1};
		options.onLine(result('pass'));
		options.onLine(result('fail', 'bad', {error: 'boom'}));
		return {...ok, code: 1};
	});
	const outcome = await runTests({suites: [suite('a')], signal: new AbortController().signal, store, spawn});
	const a = store.get().suites[0];
	assert.equal(a?.planned, 2);
	assert.equal(a?.note, '(unplanned)');
	assert.equal(a?.status, 'failed');
	assert.deepEqual(a?.failures, [{file: 'f.ts', name: 'bad', error: 'boom'}]);
	assert.equal(outcome, 'failed');
});

test('garbage lines are ignored', async () => {
	const store = createRunStore();
	const spawn = fakeSpawn((kind, _i, options) => {
		if (kind === 'discover') options.onLine(discovered(1));
		else for (const line of ['hello', '{', '{"dev":1}', result('pass'), '']) options.onLine(line);
		return ok;
	});
	await runTests({suites: [suite('a')], signal: new AbortController().signal, store, spawn});
	assert.deepEqual(store.get().suites[0]?.states, ['pass']);
});

test('a non-zero exit without failures is a suite error with a sanitised stderr tail', async () => {
	const store = createRunStore();
	const esc = String.fromCharCode(27);
	const spawn = fakeSpawn((kind, _i, options) => {
		if (kind === 'discover') options.onLine(discovered(0));
		return kind === 'run' ? {...ok, code: 3, stderr: `line1\nboom${esc}[31m red\n`} : ok;
	});
	const outcome = await runTests({suites: [suite('a')], signal: new AbortController().signal, store, spawn});
	const a = store.get().suites[0];
	assert.equal(a?.status, 'error');
	assert.equal(a?.note, 'exited with code 3');
	assert.ok(a?.failures[0]?.error?.includes('boom'));
	assert.ok(!a?.failures[0]?.error?.includes(esc));
	assert.equal(outcome, 'failed');
});

test('an unsupported script is reported without its text', async () => {
	const store = createRunStore();
	const spawn = fakeSpawn(() => ok);
	const outcome = await runTests({suites: [suite('a', 'node --test x; rm -rf /')], signal: new AbortController().signal, store, spawn});
	assert.equal(store.get().suites[0]?.note, 'Unsupported test script in a');
	assert.equal(outcome, 'failed');
});

test('the discovery temp dir exists during discovery and is deleted afterwards', async () => {
	const store = createRunStore();
	const dirs: string[] = [];
	const spawn = fakeSpawn((kind, _i, options) => {
		if (kind === 'discover') {
			const dir = options.env?.TMPDIR as string;
			assert.ok(existsSync(dir));
			dirs.push(dir);
			options.onLine(discovered(0));
		}
		return ok;
	});
	await runTests({suites: [suite('a'), suite('b')], signal: new AbortController().signal, store, spawn});
	assert.equal(dirs.length, 2);
	for (const dir of dirs) assert.equal(existsSync(dir), false);
});

test('aborting during the run marks the suites cancelled', async () => {
	const store = createRunStore();
	const controller = new AbortController();
	const spawn = fakeSpawn((kind, _i, options) => {
		if (kind === 'discover') {
			options.onLine(discovered(5));
			return ok;
		}
		options.onLine(result('pass'));
		controller.abort();
		return {...ok, code: null, aborted: true};
	});
	const outcome = await runTests({suites: [suite('a'), suite('b')], signal: controller.signal, store, spawn});
	assert.equal(outcome, 'cancelled');
	assert.deepEqual(
		store.get().suites.map(s => s.status),
		['cancelled', 'cancelled'],
	);
	assert.equal(store.get().phase, 'cancelled');
});

test('abort kills the whole process group', async () => {
	const pidFile = path.join(work, 'pids.json');
	const controller = new AbortController();
	const running = spawnNode([path.join(fixturesDir, 'spawner.mjs'), pidFile], {cwd: work, signal: controller.signal, onLine: () => {}});
	const {readFileSync} = await import('node:fs');
	for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 50));
	await new Promise(r => setTimeout(r, 50));
	const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[];
	assert.ok(pids.every(alive));
	controller.abort();
	const outcome = await running;
	assert.equal(outcome.aborted, true);
	assert.ok(await waitGone(pids));
});

test('credentials, the test-runner context and the dev child marker never reach the child', async () => {
	const names = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_TEST_CONTEXT', 'YENA_DEV_CHILD'];
	const saved = names.map(n => process.env[n]);
	for (const n of names) process.env[n] = 'dummy-value';
	try {
		const lines: string[] = [];
		const script = `console.log(JSON.stringify([${names.map(n => `process.env.${n} ?? null`).join(',')}, process.env.EXTRA ?? null]))`;
		await spawnNode(['-e', script], {cwd: work, env: {EXTRA: 'kept', ANTHROPIC_API_KEY: 'dummy-2'}, onLine: l => lines.push(l)});
		assert.deepEqual(JSON.parse(lines[0] as string), [null, null, null, null, 'kept']);
	} finally {
		names.forEach((n, i) => {
			if (saved[i] === undefined) delete process.env[n];
			else process.env[n] = saved[i];
		});
	}
});

test('oversized lines are dropped, following lines survive', async () => {
	const lines: string[] = [];
	const script = `process.stdout.write('x'.repeat(200000) + '\\n'); console.log('after')`;
	await spawnNode(['-e', script], {cwd: work, onLine: l => lines.push(l)});
	assert.deepEqual(lines, ['after']);
});

test('parseDiscoveryLine accepts only a bounded non-negative integer total', () => {
	const line = (total: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({dev: 1, kind: 'discovered', total, ...extra});
	assert.equal(parseDiscoveryLine(line(7)), 7);
	assert.equal(parseDiscoveryLine(line(0)), 0);
	for (const bad of [line(-1), line(1.5), line('3'), line(null), line(1_000_001), line(7, {kind: 'x'}), '{"dev":1,"kind":"discovered","total":1e999}', 'nope', '']) {
		assert.equal(parseDiscoveryLine(bad), undefined, bad);
	}
});

test('a timeout stops the child and reports timedOut', async () => {
	const started = Date.now();
	const outcome = await spawnNode(['-e', 'setInterval(() => {}, 1000)'], {cwd: work, timeoutMs: 200, onLine: () => {}});
	assert.equal(outcome.timedOut, true);
	assert.equal(outcome.aborted, false);
	assert.ok(Date.now() - started < 2500);
});

test('an already aborted signal never starts a child', async () => {
	const controller = new AbortController();
	controller.abort();
	const outcome = await spawnNode(['-e', 'process.exit(3)'], {cwd: work, signal: controller.signal, onLine: () => {}});
	assert.deepEqual(outcome, {code: null, signal: null, stderr: '', timedOut: false, aborted: true});
});

test('a child that ignores SIGTERM is killed with SIGKILL after the grace period', async () => {
	const controller = new AbortController();
	const script = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";
	let ready!: () => void;
	const up = new Promise<void>(r => (ready = r));
	const running = spawnNode(['-e', script], {cwd: work, signal: controller.signal, onLine: l => l === 'ready' && ready()});
	await up;
	const started = Date.now();
	controller.abort();
	const outcome = await running;
	assert.equal(outcome.signal, 'SIGKILL');
	assert.ok(Date.now() - started >= 2500);
});

test('killAll kills every live process group synchronously', async () => {
	const pidFile = path.join(work, 'killall.json');
	const running = spawnNode([path.join(fixturesDir, 'spawner.mjs'), pidFile], {cwd: work, onLine: () => {}});
	const {readFileSync} = await import('node:fs');
	let pids: number[] = [];
	for (let i = 0; i < 100 && pids.length === 0; i++) {
		await new Promise(r => setTimeout(r, 50));
		try {
			pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[];
		} catch {
			// not written yet
		}
	}
	assert.ok(pids.length === 2 && pids.every(alive));
	killAll();
	const outcome = await running;
	assert.equal(outcome.signal, 'SIGKILL');
	assert.ok(await waitGone(pids));
});
