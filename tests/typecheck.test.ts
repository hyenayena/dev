import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, test} from 'node:test';
import type {SpawnFn, SpawnResult} from '../src/spawn.js';
import type {Suite} from '../src/suites.js';
import {parseTypecheckScript, runTypecheck, type TypecheckResult} from '../src/typecheck.js';

const hostRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('every real typecheck script of the checkout parses', () => {
	let checked = 0;
	for (const dir of ['', 'modules/core', 'modules/claude', 'modules/md', 'modules/dev', 'modules/project', 'modules/task', 'modules/scheduler']) {
		const file = path.join(hostRoot, dir, 'package.json');
		if (!existsSync(file)) continue;
		const script = (JSON.parse(readFileSync(file, 'utf8')) as {scripts?: {typecheck?: string}}).scripts?.typecheck;
		if (script === undefined) continue;
		assert.ok(parseTypecheckScript(script).length > 0, dir);
		checked++;
	}
	assert.ok(checked >= 1);
});

test('steps are split on && and the arguments are kept', () => {
	assert.deepEqual(parseTypecheckScript('tsc --noEmit && tsc -p tests'), [['--noEmit'], ['-p', 'tests']]);
	assert.deepEqual(parseTypecheckScript('tsc --project "."'), [['-p', '.']]);
});

test('metacharacters, other binaries and unknown flags are rejected', () => {
	for (const script of [
		'tsc; rm -rf /',
		'tsc | cat',
		'tsc $(id)',
		'tsc `id`',
		'tsc > out',
		'tsc & tsc',
		'tsc -p . || true',
		'npx tsc',
		'node node_modules/typescript/bin/tsc',
		'tsc --watch',
		'tsc -p',
		'tsc -p --noEmit',
		'tsc *.ts',
		'tsc && ',
		'',
	]) {
		assert.throws(() => parseTypecheckScript(script), script);
	}
});

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dev-typecheck-')));
after(() => rmSync(root, {recursive: true, force: true}));
const tscFile = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
mkdirSync(path.dirname(tscFile), {recursive: true});
writeFileSync(tscFile, '');

const suite = (name: string, script = 'tsc --noEmit && tsc -p tests'): Suite => ({name, dir: path.join(root, name), script});
const ok: SpawnResult = {code: 0, signal: null, stderr: '', timedOut: false, aborted: false};

test('every step runs through node with tsc and --noEmit in the suite directory', async () => {
	const calls: Array<{args: string[]; cwd: string}> = [];
	const spawn: SpawnFn = async (args, options) => {
		calls.push({args, cwd: options.cwd});
		return ok;
	};
	const seen: TypecheckResult[] = [];
	const results = await runTypecheck({suites: [suite('a')], root, signal: new AbortController().signal, spawn, onSuite: r => seen.push(r)});
	assert.deepEqual(calls, [
		{args: [tscFile, '--noEmit'], cwd: path.join(root, 'a')},
		{args: [tscFile, '-p', 'tests', '--noEmit'], cwd: path.join(root, 'a')},
	]);
	assert.equal(results[0]?.status, 'ok');
	assert.deepEqual(seen, results);
});

test('a failing step stops the suite, counts errors and caps the diagnostics', async () => {
	let calls = 0;
	const spawn: SpawnFn = async (_args, options) => {
		calls++;
		for (let i = 0; i < 25; i++) options.onLine(`src/x.ts(${i},1): error TS2322: bad \u001b[31mtype`);
		options.onLine('Found 25 errors.');
		return {...ok, code: 2};
	};
	const [result] = await runTypecheck({suites: [suite('a')], root, signal: new AbortController().signal, spawn});
	assert.equal(calls, 1);
	assert.equal(result?.status, 'failed');
	assert.equal(result?.errors, 25);
	assert.equal(result?.lines.length, 20);
	assert.ok(!result?.lines.join('').includes('\u001b'));
});

test('a non-zero exit without diagnostics reports the stderr tail', async () => {
	const spawn: SpawnFn = async () => ({...ok, code: 1, stderr: 'boom\nlast line\n'});
	const [result] = await runTypecheck({suites: [suite('a')], root, signal: new AbortController().signal, spawn});
	assert.equal(result?.status, 'failed');
	assert.equal(result?.note, 'last line');
});

test('unsupported scripts, spawn errors and a missing tsc are errors per suite', async () => {
	const spawn: SpawnFn = async () => {
		throw new Error('spawn failed');
	};
	const results = await runTypecheck({suites: [suite('a', 'tsc; id'), suite('b')], root, signal: new AbortController().signal, spawn});
	assert.deepEqual(results.map(r => r.status), ['error', 'error']);
	assert.equal(results[0]?.note, 'Unsupported typecheck script in a');

	const empty = realpathSync(mkdtempSync(path.join(tmpdir(), 'dev-typecheck-empty-')));
	try {
		const [missing] = await runTypecheck({suites: [suite('a')], root: empty, signal: new AbortController().signal, spawn});
		assert.equal(missing?.status, 'error');
		assert.equal(missing?.note, 'TypeScript is not installed');
	} finally {
		rmSync(empty, {recursive: true, force: true});
	}
});

test('an abort cancels the running suite and the remaining ones', async () => {
	const ac = new AbortController();
	const spawn: SpawnFn = async () => {
		ac.abort();
		return {...ok, code: null, aborted: true};
	};
	const results = await runTypecheck({suites: [suite('a'), suite('b')], root, signal: ac.signal, spawn});
	assert.deepEqual(results.map(r => r.status), ['cancelled', 'cancelled']);
});
