import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Logger} from '../../../src/api.js';
import type {DotState} from './kit.js';
import {sanitizeText} from './kit.js';
import {noopLog} from './log.js';
import {parseTestScript, type TestScript} from './script.js';
import type {SpawnFn, SpawnResult} from './spawn.js';
import type {RunStore, SuiteState} from './store.js';
import type {Suite} from './suites.js';

export type RunOutcome = 'ok' | 'failed' | 'cancelled';

export type RunDeps = {
	suites: Suite[];
	signal: AbortSignal;
	store: RunStore;
	log?: Logger;
	spawn: SpawnFn;
	namePattern?: string;
};

export type ResultLine = {kind: 'pass' | 'fail' | 'skip' | 'todo'; name: string; file: string; ms: number; error?: string};

const DISCOVER = fileURLToPath(new URL('./child/discover.ts', import.meta.url));
const REPORTER = fileURLToPath(new URL('./child/reporter.ts', import.meta.url));
const DISCOVERY_PARALLEL = 4;
const DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_FAILURES = 200;
const MAX_TOTAL = 1_000_000;
const KINDS = new Set(['pass', 'fail', 'skip', 'todo']);
const TMP_PREFIX = 'yena-dev-';

const capped = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');

export function parseResultLine(line: string): ResultLine | undefined {
	if (line.length === 0 || line[0] !== '{') return undefined;
	try {
		const value = JSON.parse(line) as Record<string, unknown> | null;
		if (typeof value !== 'object' || value === null || value.dev !== 1) return undefined;
		const kind = value.kind;
		if (typeof kind !== 'string' || !KINDS.has(kind)) return undefined;
		const result: ResultLine = {
			kind: kind as ResultLine['kind'],
			name: capped(value.name),
			file: capped(value.file),
			ms: typeof value.ms === 'number' && Number.isFinite(value.ms) ? value.ms : 0,
		};
		if (typeof value.error === 'string') result.error = capped(value.error);
		return result;
	} catch {
		return undefined;
	}
}

export function parseDiscoveryLine(line: string): number | undefined {
	if (line.length === 0 || line[0] !== '{') return undefined;
	try {
		const value = JSON.parse(line) as Record<string, unknown> | null;
		if (typeof value !== 'object' || value === null || value.dev !== 1 || value.kind !== 'discovered') return undefined;
		const total = value.total;
		return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 && total <= MAX_TOTAL ? total : undefined;
	} catch {
		return undefined;
	}
}

const withTsx = (nodeArgs: string[]): string[] => {
	for (let i = 0; i < nodeArgs.length; i++) {
		if (nodeArgs[i] === '--import=tsx' || (nodeArgs[i] === '--import' && nodeArgs[i + 1] === 'tsx')) return nodeArgs;
	}
	return [...nodeArgs, '--import', 'tsx'];
};

function removeTempDir(dir: string): void {
	const root = realpathSync(tmpdir());
	const real = realpathSync(dir);
	if (path.dirname(real) !== root || !path.basename(real).startsWith(TMP_PREFIX)) return;
	rmSync(real, {recursive: true, force: true});
}

const count = (states: DotState[], wanted: DotState): number => states.filter(s => s === wanted).length;

export async function runTests(deps: RunDeps): Promise<RunOutcome> {
	const {suites, signal, store, spawn} = deps;
	const log = deps.log ?? noopLog;
	const scripts = new Map<string, TestScript>();

	const patch = (name: string, mutate: (s: SuiteState) => void): void =>
		store.update(state => {
			const suite = state.suites.find(s => s.name === name);
			if (suite) mutate(suite);
		});

	store.update(state => {
		state.phase = 'discovering';
		state.suites = suites.map(s => ({name: s.name, planned: 0, states: [], status: 'pending', failures: []}));
	});
	for (const suite of suites) {
		try {
			const parsed = parseTestScript(suite.script);
			scripts.set(suite.name, suite.files ? {...parsed, globs: suite.files} : parsed);
		} catch {
			patch(suite.name, s => {
				s.status = 'error';
				s.note = `Unsupported test script in ${suite.name}`;
				s.failures.push({file: suite.name, name: s.note});
			});
		}
	}
	store.flush();

	const runnable = suites.filter(s => scripts.has(s.name));

	const discover = async (suite: Suite): Promise<void> => {
		const script = scripts.get(suite.name) as TestScript;
		const tmp = mkdtempSync(path.join(realpathSync(tmpdir()), TMP_PREFIX));
		let total: number | undefined;
		let code: number | null | undefined;
		let failure: unknown;
		try {
			const result = await spawn([...withTsx(script.nodeArgs), DISCOVER, ...script.globs], {
				cwd: suite.dir,
				env: {TMPDIR: tmp},
				signal,
				timeoutMs: DISCOVERY_TIMEOUT_MS,
				onLine: line => {
					total = parseDiscoveryLine(line) ?? total;
				},
			});
			code = result.code;
			if (result.aborted) return;
		} catch (err) {
			failure = err;
		} finally {
			try {
				removeTempDir(tmp);
			} catch (err) {
				log.warn('temp dir cleanup failed', {suite: suite.name, err});
			}
		}
		if (total === undefined) {
			log.warn('discovery failed', {suite: suite.name, code, ...(failure === undefined ? {} : {err: failure})});
			patch(suite.name, s => {
				s.note = '(unplanned)';
			});
			return;
		}
		patch(suite.name, s => {
			s.planned = total as number;
		});
	};

	let next = 0;
	const worker = async (): Promise<void> => {
		while (!signal.aborted && next < runnable.length) {
			await discover(runnable[next++] as Suite);
		}
	};
	if (deps.namePattern === undefined) await Promise.all(Array.from({length: Math.min(DISCOVERY_PARALLEL, runnable.length)}, worker));

	const planned = store.get().suites.reduce((n, s) => n + s.planned, 0);
	log.info('test run started', {suites: runnable.length, planned});
	store.update(state => {
		state.phase = 'running';
	});
	store.flush();

	for (const suite of runnable) {
		if (signal.aborted) break;
		await runSuite(suite, scripts.get(suite.name) as TestScript);
	}

	async function runSuite(suite: Suite, script: TestScript): Promise<void> {
		const started = Date.now();
		patch(suite.name, s => {
			s.status = 'running';
		});
		let result: SpawnResult | undefined;
		let startError: unknown;
		try {
			result = await spawn(
				[
					...script.nodeArgs,
					'--test',
					`--test-reporter=${REPORTER}`,
					'--test-reporter-destination=stdout',
					...script.testArgs,
					...(deps.namePattern === undefined ? [] : [`--test-name-pattern=${deps.namePattern}`]),
					...script.globs,
				],
				{
					cwd: suite.dir,
					signal,
					onLine: line => {
						const item = parseResultLine(line);
						if (!item) return;
						const dot: DotState = item.kind === 'fail' ? 'fail' : item.kind === 'pass' ? 'pass' : 'skip';
						patch(suite.name, s => {
							s.states.push(dot);
							if (s.states.length > s.planned) s.planned = s.states.length;
							if (item.kind === 'fail' && s.failures.length < MAX_FAILURES) {
								s.failures.push({file: item.file, name: item.name, ...(item.error === undefined ? {} : {error: item.error})});
							}
						});
					},
				},
			);
		} catch (err) {
			startError = err;
		}
		const ms = Date.now() - started;
		const states = store.get().suites.find(s => s.name === suite.name)?.states ?? [];
		const failed = count(states, 'fail');
		const code = result?.code ?? null;
		const cancelled = result?.aborted === true || signal.aborted;
		patch(suite.name, s => {
			s.ms = ms;
			if (cancelled) {
				s.status = 'cancelled';
				return;
			}
			if (startError !== undefined) {
				s.status = 'error';
				s.note = 'could not start the test process';
				return;
			}
			if (s.states.length < s.planned) s.note = `${s.planned - s.states.length} not run`;
			if (failed > 0) s.status = 'failed';
			else if (code !== 0) {
				s.status = 'error';
				s.note = `exited with code ${code}`;
				const tail = sanitizeText(result?.stderr.trim().split('\n').slice(-3).join(' '), 300);
				s.failures.push({file: suite.name, name: s.note, ...(tail ? {error: tail} : {})});
			} else s.status = 'passed';
		});
		log.info('suite finished', {
			suite: suite.name,
			total: states.length,
			passed: count(states, 'pass'),
			failed,
			skipped: count(states, 'skip'),
			ms,
			code,
		});
	}

	const cancelled = signal.aborted;
	store.update(state => {
		state.phase = cancelled ? 'cancelled' : 'done';
		state.endedAt = Date.now();
		if (cancelled) {
			for (const s of state.suites) if (s.status === 'pending' || s.status === 'running') s.status = 'cancelled';
		}
	});
	store.flush();

	const final = store.get();
	const states = final.suites.flatMap(s => s.states);
	const bad = final.suites.some(s => s.status === 'failed' || s.status === 'error');
	const outcome: RunOutcome = cancelled ? 'cancelled' : bad ? 'failed' : 'ok';
	log.info('test run finished', {
		total: states.length,
		passed: count(states, 'pass'),
		failed: count(states, 'fail'),
		ms: (final.endedAt ?? Date.now()) - final.startedAt,
		outcome,
	});
	return outcome;
}
