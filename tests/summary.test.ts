import assert from 'node:assert/strict';
import {test} from 'node:test';
import {summaryLines} from '../src/summary.js';
import type {RunState} from '../src/store.js';

const ESC = String.fromCharCode(27);
const base = (over: Partial<RunState> = {}): RunState => ({
	phase: 'done',
	startedAt: 0,
	endedAt: 44_200,
	suites: [
		{name: 'host', planned: 10, states: ['pass', 'pass', 'fail', 'skip', ...Array<'pass'>(6).fill('pass')], status: 'failed', failures: [{file: 'tests/a.test.ts', name: 'breaks', error: 'expected 1'}], ms: 1200},
		{name: 'md', planned: 2, states: ['pass', 'pass'], status: 'passed', failures: [], ms: 30},
	],
	...over,
});

test('first line summarises the run', () => {
	const lines = summaryLines(base(), {columns: 80, color: false});
	assert.equal(lines[0], 'Tests: 10/12 passed · 1 failed · 1 skipped · 44.2s');
	assert.ok(lines.includes('✖ tests/a.test.ts › breaks'));
	assert.ok(lines.includes('  expected 1'));
});

test('a cancelled run says so', () => {
	assert.match(summaryLines(base({phase: 'cancelled'}), {columns: 80, color: false})[0] as string, /^Cancelled after 44\.2s/);
});

test('without colour there is no escape character', () => {
	assert.ok(!summaryLines(base(), {columns: 80, color: false}).join('\n').includes(ESC));
});

test('with colour only SGR sequences appear', () => {
	const text = summaryLines(base(), {columns: 80, color: true}).join('\n');
	assert.ok(text.includes(ESC));
	assert.ok(!text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').includes(ESC));
});

test('bars wrap at the width', () => {
	const lines = summaryLines(
		base({suites: [{name: 'big', planned: 400, states: Array<'pass'>(400).fill('pass'), status: 'passed', failures: []}]}),
		{columns: 11, color: false},
	);
	assert.ok(lines.slice(2).every(l => Array.from(l).length <= 10));
});

test('control characters and bidi in test names are removed', () => {
	const state = base({suites: [{name: 'host', planned: 1, states: ['fail'], status: 'failed', failures: [{file: 'f', name: `bad${ESC}]0;title\u0007 name‮`, error: `x${ESC}[2Jy`}]}]});
	const text = summaryLines(state, {columns: 80, color: false}).join('\n');
	assert.ok(!text.includes(ESC));
	assert.ok(!text.includes('‮'));
	assert.ok(!text.includes('\u0007'));
});

test('failures are capped at 50 with a count of the rest', () => {
	const failures = Array.from({length: 53}, (_, i) => ({file: 'f', name: `t${i}`}));
	const state = base({suites: [{name: 'host', planned: 53, states: Array<'fail'>(53).fill('fail'), status: 'failed', failures}]});
	const lines = summaryLines(state, {columns: 80, color: false});
	assert.equal(lines.filter(l => l.startsWith('✖ f › ')).length, 50);
	assert.equal(lines.at(-1), '+3 more failures');
});
