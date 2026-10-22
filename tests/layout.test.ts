import assert from 'node:assert/strict';
import {test} from 'node:test';
import {layoutRun, rowCount, type LayoutRow} from '../src/layout.js';
import {stringCells, type DotState} from '../src/kit.js';
import type {RunState, SuiteState} from '../src/store.js';

const dots = (n: number, state: DotState = 'pass'): DotState[] => Array.from({length: n}, () => state);
const suite = (name: string, status: SuiteState['status'], done: number, planned: number, over: Partial<SuiteState> = {}): SuiteState => ({
	name,
	planned,
	states: dots(done),
	status,
	failures: [],
	...over,
});
const state = (suites: SuiteState[], phase: RunState['phase'] = 'running'): RunState => ({phase, startedAt: 0, suites});

const widthOf = (row: LayoutRow): number => (row.kind === 'header' ? 2 + stringCells(row.text) : row.kind === 'bar' ? row.width : stringCells(row.text));

const sample = (): RunState =>
	state([
		suite('host', 'passed', 154, 154, {ms: 4000}),
		suite('core', 'passed', 405, 405, {ms: 9000}),
		suite('claude', 'running', 100, 652),
		suite('md', 'pending', 0, 3),
		suite('dev', 'failed', 3, 3, {failures: [{file: 'tests/a.test.ts', name: 'x'.repeat(100), error: 'e'.repeat(100)}, {file: 'b', name: 'c'}]}),
	]);

test('rows never exceed the budget or the width', () => {
	for (const columns of [10, 20, 28, 60]) {
		for (let rows = 1; rows <= 40; rows++) {
			const layout = layoutRun(sample(), columns, rows);
			assert.ok(rowCount(layout) <= rows, `${columns}x${rows}: ${rowCount(layout)}`);
			for (const row of layout) assert.ok(widthOf(row) <= columns - 1, `${columns}x${rows} ${row.kind}`);
		}
	}
});

test('a roomy panel shows every bar and a cancel hint', () => {
	const layout = layoutRun(sample(), 28, 200);
	assert.equal(layout.filter(r => r.kind === 'header').length, 5);
	assert.ok(layout.filter(r => r.kind === 'bar').length >= 4);
	assert.deepEqual(layout.at(-1), {kind: 'hint', text: 'Esc cancel', tone: 'dim'});
});

test('finished passing suites collapse first, the running bar stays', () => {
	const full = rowCount(layoutRun(sample(), 28, 200));
	const layout = layoutRun(sample(), 28, full - 1);
	const bars = layout.filter((r): r is Extract<LayoutRow, {kind: 'bar'}> => r.kind === 'bar');
	const headers = layout.filter((r): r is Extract<LayoutRow, {kind: 'header'}> => r.kind === 'header');
	assert.equal(headers.length, 5);
	const barAfter = (name: string): boolean => {
		const i = layout.findIndex(r => r.kind === 'header' && r.text.startsWith(name));
		return layout[i + 1]?.kind === 'bar';
	};
	assert.equal(barAfter('host'), false);
	assert.equal(barAfter('claude'), true);
	assert.ok(bars.every(b => b.maxRows === undefined));
});

test('the running bar is windowed on the frontier when space is short', () => {
	const layout = layoutRun(sample(), 28, 12);
	const bar = layout.find(r => r.kind === 'bar' && r.maxRows !== undefined);
	assert.ok(bar && bar.kind === 'bar');
	assert.ok(bar.focus > 0);
});

test('failures collapse into a +N more row', () => {
	const layout = layoutRun(sample(), 28, 9);
	assert.ok(layout.some(r => r.kind === 'failure' && /^\+\d+ more$/.test(r.text)));
});

test('a finished run has no hint', () => {
	assert.ok(!layoutRun(state([suite('a', 'passed', 2, 2)], 'done'), 40, 10).some(r => r.kind === 'hint'));
});

test('untrusted names are sanitised', () => {
	const esc = String.fromCharCode(27);
	const layout = layoutRun(state([suite('a', 'failed', 1, 1, {failures: [{file: 'f', name: `n${esc}[31m‮`, error: `e${esc}]0;t\u0007`}]})], 'done'), 60, 10);
	for (const row of layout) if ('text' in row) assert.ok(!/[\u0000-\u001f\u007f-\u009f‮]/.test(row.text));
});
