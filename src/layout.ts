import {BRAILLE_FILL, brailleCells, brailleRows, sanitizeText, truncateCells, type DotState, type Tone} from './kit.js';
import {formatDuration} from './format.js';
import type {Failure, RunState, SuiteState} from './store.js';

export type LayoutRow =
	| {kind: 'header'; icon: string; text: string; tone: Tone}
	| {kind: 'bar'; states: DotState[]; width: number; maxRows?: number; focus: number; lines: number}
	| {kind: 'failure'; text: string; tone: Tone}
	| {kind: 'hint'; text: string; tone: Tone};

export const SPINNER_ICON = 'spinner';

export const rowCount = (rows: readonly LayoutRow[]): number => rows.reduce((n, r) => n + (r.kind === 'bar' ? r.lines : 1), 0);

const ICON: Record<SuiteState['status'], string> = {
	pending: '·',
	running: SPINNER_ICON,
	passed: '✔',
	failed: '✖',
	error: '✖',
	cancelled: '·',
};
const TONE: Record<SuiteState['status'], Tone> = {
	pending: 'dim',
	running: 'plain',
	passed: 'add',
	failed: 'del',
	error: 'del',
	cancelled: 'warn',
};

type Config = {headerOnly: Set<number>; runningMax: number | undefined; failureGroups: number};

const padded = (suite: SuiteState): DotState[] => {
	const states = suite.states.slice();
	while (states.length < suite.planned) states.push('pending');
	return states;
};

function headerText(suite: SuiteState): string {
	const parts = [sanitizeText(suite.name, 64), `${suite.states.length}/${Math.max(suite.planned, suite.states.length)}`];
	if (suite.ms !== undefined) parts.push(formatDuration(suite.ms));
	if (suite.note) parts.push(sanitizeText(suite.note, 80));
	return parts.join(' ');
}

function failureGroups(failures: Failure[], textWidth: number): LayoutRow[][] {
	return failures.map(f => {
		const file = sanitizeText(f.file, 200);
		const name = sanitizeText(f.name, 200);
		const rows: LayoutRow[] = [{kind: 'failure', text: truncateCells(`✖ ${file ? `${file} › ` : ''}${name}`, textWidth), tone: 'del'}];
		if (f.error) rows.push({kind: 'failure', text: truncateCells(`  ${sanitizeText(f.error, 500)}`, textWidth), tone: 'dim'});
		return rows;
	});
}

export function layoutRun(state: RunState, columns: number, rows: number): LayoutRow[] {
	const width = Math.max(1, Math.floor(columns) - 1);
	const budget = Math.max(1, Math.floor(rows));
	const running = state.phase === 'discovering' || state.phase === 'running';
	const groups = failureGroups(
		state.suites.flatMap(s => s.failures),
		width,
	);
	const hint: LayoutRow | undefined = running
		? {kind: 'hint', text: truncateCells(state.phase === 'discovering' ? 'Discovering tests · Esc cancel' : 'Esc cancel', width), tone: 'dim'}
		: undefined;

	const build = (cfg: Config): LayoutRow[] => {
		const out: LayoutRow[] = [];
		state.suites.forEach((suite, i) => {
			const icon = ICON[suite.status];
			out.push({kind: 'header', icon, text: truncateCells(headerText(suite), Math.max(1, width - 2)), tone: TONE[suite.status]});
			const states = padded(suite);
			if (cfg.headerOnly.has(i) || states.length === 0) return;
			const max = suite.status === 'running' ? cfg.runningMax : undefined;
			const focus = Math.floor(Math.min(suite.states.length, states.length - 1) / BRAILLE_FILL.length);
			const lines = brailleRows(brailleCells(states), width, {...(max === undefined ? {} : {maxRows: max}), focus}).rows.length;
			out.push({kind: 'bar', states, width, ...(max === undefined ? {} : {maxRows: max}), focus, lines});
		});
		for (const group of groups.slice(0, cfg.failureGroups)) out.push(...group);
		const hiddenGroups = groups.length - Math.min(groups.length, cfg.failureGroups);
		if (hiddenGroups > 0) out.push({kind: 'failure', text: truncateCells(`+${hiddenGroups} more`, width), tone: 'dim'});
		if (hint) out.push(hint);
		return out;
	};

	const cfg: Config = {headerOnly: new Set(), runningMax: undefined, failureGroups: groups.length};
	const fits = (): boolean => rowCount(build(cfg)) <= budget;
	const indexes = (pick: (s: SuiteState) => boolean): number[] => state.suites.flatMap((s, i) => (pick(s) ? [i] : []));
	const collapse = (list: number[]): boolean => {
		for (const i of list) {
			cfg.headerOnly.add(i);
			if (fits()) return true;
		}
		return false;
	};

	const shrunk = (): boolean => {
		if (fits()) return true;
		if (collapse(indexes(s => s.status === 'passed'))) return true;
		if (collapse(indexes(s => s.status === 'pending' || s.status === 'cancelled'))) return true;
		const runningIndex = state.suites.findIndex(s => s.status === 'running');
		if (runningIndex >= 0) {
			const total = brailleRows(brailleCells(padded(state.suites[runningIndex] as SuiteState)), width).rows.length;
			for (let max = total; max >= 1; max--) {
				cfg.runningMax = max;
				if (fits()) return true;
			}
		}
		for (let k = groups.length - 1; k >= 0; k--) {
			cfg.failureGroups = k;
			if (fits()) return true;
		}
		return collapse(indexes(() => true));
	};
	shrunk();

	const result = build(cfg);
	if (rowCount(result) <= budget) return result;
	const keep = hint ? budget - 1 : budget;
	const body = result.filter(r => r !== hint).slice(0, Math.max(0, keep));
	return hint && budget >= 1 ? [...body, hint] : body;
}
