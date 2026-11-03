import type {SpanTone, StyledBlock, StyledSpan} from '../../../src/api.js';
import {brailleCells, brailleRows, line, MAX_SPANS, sanitizeText, span, stringCells, type BrailleCell, type DotState, type Tone} from './kit.js';
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

const ICON_TONE: Record<SuiteState['status'], SpanTone> = {
	pending: 'muted',
	running: 'muted',
	passed: 'ok',
	failed: 'error',
	error: 'error',
	cancelled: 'muted',
};

const COUNT_TONE: Partial<Record<SuiteState['status'], SpanTone>> = {passed: 'ok', failed: 'error', error: 'error', cancelled: 'muted'};

const BAR_TONE: Partial<Record<Tone, SpanTone>> = {add: 'ok', del: 'error', warn: 'warn', info: 'accent', dim: 'muted'};

export const SEP = span(' · ', {tone: 'muted'});

export const pad = (cells: number): StyledSpan[] => (cells > 0 ? [span(' '.repeat(cells), {decor: true})] : []);

export const countSpans = (passed: number, total: number, failed: number): StyledSpan[] => [
	span(`${passed}/${total} passed`, {tone: 'ok'}),
	SEP,
	span(`${failed} failed`, {tone: failed > 0 ? 'error' : 'muted'}),
];

function barSpans(cells: readonly BrailleCell[]): StyledSpan[] {
	const runs: {text: string; tone: Tone; del: boolean}[] = [];
	for (const cell of cells) {
		const last = runs.at(-1);
		if (last && last.tone === cell.tone) last.text += cell.glyph;
		else runs.push({text: cell.glyph, tone: cell.tone, del: cell.tone === 'del'});
	}
	if (runs.length > MAX_SPANS) {
		const rest = runs.splice(MAX_SPANS - 1);
		const del = rest.some(r => r.del);
		runs.push({text: rest.map(r => r.text).join(''), tone: del ? 'del' : rest[0]!.tone, del});
	}
	return runs.map(r => {
		const tone = BAR_TONE[r.tone];
		return tone === undefined ? span(r.text) : span(r.text, {tone});
	});
}

export function summaryBlocks(state: RunState, options: {columns: number; bars?: boolean}): StyledBlock[] {
	const width = Math.max(1, Math.floor(options.columns) - 1);
	const all = state.suites.flatMap(s => s.states);
	const planned = state.suites.reduce((n, s) => n + Math.max(s.planned, s.states.length), 0);
	const elapsed = formatDuration((state.endedAt ?? Date.now()) - state.startedAt);
	const skipped = count(all, 'skip');
	const counts = [...countSpans(count(all, 'pass'), planned, count(all, 'fail')), SEP, span(`${skipped} skipped`, {tone: skipped > 0 ? 'warn' : 'muted'})];
	const blocks: StyledBlock[] = [
		state.phase === 'cancelled'
			? line(span(`Cancelled after ${elapsed}`, {tone: 'warn'}), SEP, ...counts)
			: line(span('Tests:', {bold: true}), ' ', ...counts, SEP, span(elapsed, {tone: 'muted'})),
	];

	const rows = state.suites.map(suite => ({
		suite,
		name: sanitizeText(suite.name, 64),
		count: `${suite.states.length}/${Math.max(suite.planned, suite.states.length)}`,
		ms: suite.ms === undefined ? undefined : formatDuration(suite.ms),
		note: suite.note ? sanitizeText(suite.note, 80) : undefined,
	}));
	const nameWidth = Math.max(0, ...rows.map(r => stringCells(r.name)));
	const countWidth = Math.max(0, ...rows.map(r => stringCells(r.count)));
	const msWidth = Math.max(0, ...rows.map(r => (r.ms === undefined ? 0 : stringCells(r.ms) + 1)));

	for (const r of rows) {
		const {suite} = r;
		const countTone = COUNT_TONE[suite.status];
		const tail = r.ms !== undefined || r.note !== undefined;
		const spans: (string | StyledSpan)[] = [
			span(ICON[suite.status], {tone: ICON_TONE[suite.status]}),
			' ',
			span(r.name, {bold: true}),
			...pad(nameWidth - stringCells(r.name)),
			' ',
			countTone === undefined ? span(r.count) : span(r.count, {tone: countTone}),
		];
		if (tail) spans.push(...pad(countWidth - stringCells(r.count)));
		if (r.ms !== undefined) spans.push(' ', span(r.ms, {tone: 'muted'}));
		if (r.note !== undefined) {
			spans.push(...pad(msWidth - (r.ms === undefined ? 0 : stringCells(r.ms) + 1)), ' ', span(r.note, {tone: 'warn'}));
		}
		blocks.push(line(...spans));
		if (options.bars === false) continue;
		const states = suite.states.slice();
		while (states.length < suite.planned) states.push('pending');
		for (const row of brailleRows(brailleCells(states), width).rows) blocks.push(line(...barSpans(row)));
	}

	const failures = state.suites.flatMap(s => s.failures);
	for (const f of failures.slice(0, MAX_FAILURES_SHOWN)) {
		const file = sanitizeText(f.file, 200);
		blocks.push(
			line(
				span('✖', {tone: 'error'}),
				' ',
				...(file ? [span(file, {tone: 'muted'}), span(' › ', {tone: 'muted'})] : []),
				sanitizeText(f.name, 200),
			),
		);
		if (f.error) blocks.push(line(`  ${sanitizeText(f.error, 500)}`));
	}
	if (failures.length > MAX_FAILURES_SHOWN) blocks.push(line(span(`+${failures.length - MAX_FAILURES_SHOWN} more failures`, {tone: 'warn'})));
	return blocks;
}
