import {realpathSync} from 'node:fs';
import path from 'node:path';
import type {Logger} from '../../../src/api.js';
import {sanitizeText} from './kit.js';
import {noopLog} from './log.js';
import {METACHARACTERS, tokenize} from './script.js';
import type {SpawnFn} from './spawn.js';
import type {Suite} from './suites.js';

export type TypecheckStatus = 'ok' | 'failed' | 'error' | 'cancelled';

export type TypecheckResult = {
	name: string;
	status: TypecheckStatus;
	ms: number;
	errors: number;
	lines: string[];
	note?: string;
};

export type TypecheckDeps = {
	suites: Suite[];
	root: string;
	signal: AbortSignal;
	spawn: SpawnFn;
	onSuite?: (result: TypecheckResult) => void;
	log?: Logger;
};

const MAX_LINES = 20;
const MAX_LINE_LENGTH = 300;
const STEP_TIMEOUT_MS = 10 * 60_000;
const ERROR_LINE = /error TS\d+/;

export function parseTypecheckScript(script: string): string[][] {
	const steps: string[][] = [];
	for (const part of script.split('&&')) {
		if (METACHARACTERS.test(part)) throw new Error('shell metacharacter');
		const [binary, ...args] = tokenize(part);
		if (binary !== 'tsc') throw new Error('not a tsc command');
		const step: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i] as string;
			if (arg === '--noEmit') {
				step.push(arg);
			} else if (arg === '-p' || arg === '--project') {
				const value = args[++i];
				if (value === undefined || value === '' || value.startsWith('-')) throw new Error('missing project path');
				step.push('-p', value);
			} else {
				throw new Error('unsupported flag');
			}
		}
		steps.push(step);
	}
	return steps;
}

function tscPath(root: string): string {
	const realRoot = realpathSync(root);
	const tsc = realpathSync(path.join(realRoot, 'node_modules', 'typescript', 'bin', 'tsc'));
	if (!tsc.startsWith(realRoot + path.sep)) throw new Error('tsc leaves the yena root');
	return tsc;
}

export async function runTypecheck(deps: TypecheckDeps): Promise<TypecheckResult[]> {
	const {suites, signal, spawn} = deps;
	const log = deps.log ?? noopLog;
	const results: TypecheckResult[] = [];
	const finish = (result: TypecheckResult): void => {
		results.push(result);
		deps.onSuite?.(result);
	};
	let tsc: string | undefined;
	let tscError: unknown;
	try {
		tsc = tscPath(deps.root);
	} catch (err) {
		tscError = err;
	}

	for (const suite of suites) {
		const started = Date.now();
		const base = {name: suite.name, errors: 0, lines: [] as string[]};
		const elapsed = (): number => Date.now() - started;
		if (signal.aborted) {
			finish({...base, status: 'cancelled', ms: 0});
			continue;
		}
		let steps: string[][];
		try {
			steps = parseTypecheckScript(suite.script);
		} catch {
			finish({...base, status: 'error', ms: 0, note: `Unsupported typecheck script in ${suite.name}`});
			continue;
		}
		if (tsc === undefined) {
			log.warn('tsc not found', {suite: suite.name, err: tscError});
			finish({...base, status: 'error', ms: 0, note: 'TypeScript is not installed'});
			continue;
		}

		let errors = 0;
		const lines: string[] = [];
		let status: TypecheckStatus = 'ok';
		let note: string | undefined;
		try {
			for (const step of steps) {
				const onLine = (line: string): void => {
					if (!ERROR_LINE.test(line)) return;
					errors++;
					if (lines.length < MAX_LINES) lines.push(sanitizeText(line, MAX_LINE_LENGTH));
				};
				const result = await spawn([tsc, ...step, ...(step.includes('--noEmit') ? [] : ['--noEmit'])], {cwd: suite.dir, signal, timeoutMs: STEP_TIMEOUT_MS, onLine});
				if (result.aborted) {
					status = 'cancelled';
					break;
				}
				if (result.timedOut) {
					status = 'error';
					note = 'Typecheck timed out';
					break;
				}
				if (result.code !== 0) {
					status = 'failed';
					if (errors === 0) note = sanitizeText(result.stderr.trim().split('\n').at(-1) ?? '', MAX_LINE_LENGTH) || `tsc exited with ${result.signal ?? result.code}`;
					break;
				}
			}
		} catch (err) {
			log.warn('typecheck failed to start', {suite: suite.name, err});
			status = 'error';
			note = 'Could not start tsc';
		}
		finish({name: suite.name, status, ms: elapsed(), errors, lines, ...(note ? {note} : {})});
	}
	log.info('typecheck finished', {suites: results.length, failed: results.filter(r => r.status !== 'ok').length});
	return results;
}
