import {brailleCells, brailleRows, brailleText, sanitizeText, type DotState} from './kit.js';
import {formatDuration} from './format.js';
import type {RunState, SuiteState} from './store.js';

const MAX_FAILURES_SHOWN = 50;

const count = (states: DotState[], wanted: DotState): number => states.filter(s => s === wanted).length;

const ICON: Record<SuiteState['status'], string> = {
	pending: '·',
	running: '·',
	passed: '✔',
	failed: '✖',
	error: '✖',
	cancelled: '·',
};

/** Final report for `ctx.print`; `color` adds SGR to the bars only; `bars: false` leaves the bars out. */
export function summaryLines(state: RunState, options: {columns: number; color: boolean; bars?: boolean}): string[] {
	const width = Math.max(1, Math.floor(options.columns) - 1);
	const all = state.suites.flatMap(s => s.states);
	const planned = state.suites.reduce((n, s) => n + Math.max(s.planned, s.states.length), 0);
	const elapsed = formatDuration((state.endedAt ?? Date.now()) - state.startedAt);
	const counts = `${count(all, 'pass')}/${planned} passed · ${count(all, 'fail')} failed · ${count(all, 'skip')} skipped`;
	const lines = [state.phase === 'cancelled' ? `Cancelled after ${elapsed} · ${counts}` : `Tests: ${counts} · ${elapsed}`];

	for (const suite of state.suites) {
		const parts = [`${ICON[suite.status]} ${sanitizeText(suite.name, 64)}`, `${suite.states.length}/${Math.max(suite.planned, suite.states.length)}`];
		if (suite.ms !== undefined) parts.push(formatDuration(suite.ms));
		if (suite.note) parts.push(sanitizeText(suite.note, 80));
		lines.push(parts.join(' '));
		if (options.bars === false) continue;
		const states = suite.states.slice();
		while (states.length < suite.planned) states.push('pending');
		for (const row of brailleRows(brailleCells(states), width).rows) lines.push(brailleText(row, {color: options.color}));
	}

	const failures = state.suites.flatMap(s => s.failures);
	for (const f of failures.slice(0, MAX_FAILURES_SHOWN)) {
		const file = sanitizeText(f.file, 200);
		lines.push(`✖ ${file ? `${file} › ` : ''}${sanitizeText(f.name, 200)}`);
		if (f.error) lines.push(`  ${sanitizeText(f.error, 500)}`);
	}
	if (failures.length > MAX_FAILURES_SHOWN) lines.push(`+${failures.length - MAX_FAILURES_SHOWN} more failures`);
	return lines;
}
