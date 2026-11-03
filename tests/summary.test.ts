import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {StyledBlock, StyledSpan} from '../../../src/api.js';
import {MAX_SPANS, plainLines, renderStyled, type DotState} from '../src/kit.js';
import {summaryBlocks} from '../src/summary.js';
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

const lines = (state: RunState, columns = 80, bars?: boolean): string[] => plainLines(summaryBlocks(state, {columns, ...(bars === undefined ? {} : {bars})}));
const spansOf = (b: StyledBlock): StyledSpan[] => (b.kind === 'line' ? b.spans.map(s => (typeof s === 'string' ? {text: s} : s)) : []);
const toneOf = (b: StyledBlock, text: string): string | undefined => spansOf(b).find(s => s.text === text)?.tone;

test('first line summarises the run', () => {
	const out = lines(base());
	assert.equal(out[0], 'Tests: 10/12 passed · 1 failed · 1 skipped · 44.2s');
	assert.ok(out.includes('✖ tests/a.test.ts › breaks'));
	assert.ok(out.includes('  expected 1'));
});

test('the header is toned: passed ok, failed error, skipped warn, the rest muted', () => {
	const head = summaryBlocks(base(), {columns: 80})[0]!;
	assert.equal(head.kind, 'line');
	assert.equal(spansOf(head)[0]?.bold, true);
	assert.equal(toneOf(head, '10/12 passed'), 'ok');
	assert.equal(toneOf(head, '1 failed'), 'error');
	assert.equal(toneOf(head, '1 skipped'), 'warn');
	assert.equal(toneOf(head, '44.2s'), 'muted');
	assert.equal(toneOf(head, ' · '), 'muted');
	const clean = summaryBlocks(base({suites: [{name: 'md', planned: 1, states: ['pass'], status: 'passed', failures: []}]}), {columns: 80})[0]!;
	assert.equal(toneOf(clean, '0 failed'), 'muted');
	assert.equal(toneOf(clean, '0 skipped'), 'muted');
});

test('a cancelled run says so in warn', () => {
	const blocks = summaryBlocks(base({phase: 'cancelled'}), {columns: 80});
	assert.match(plainLines(blocks)[0] as string, /^Cancelled after 44\.2s · 10\/12 passed/);
	assert.equal(toneOf(blocks[0]!, 'Cancelled after 44.2s'), 'warn');
});

test('suite lines stay single-spaced in plain and align for the human', () => {
	const state = base();
	const plain = lines(state, 80, false);
	assert.equal(plain[1], '✖ host 10/10 1.2s');
	assert.equal(plain[2], '✔ md 2/2 30ms');
	const human = renderStyled(summaryBlocks(state, {columns: 80, bars: false}), 80, {color: false}).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').split('\n');
	assert.equal(human[1], '✖ host 10/10 1.2s');
	assert.equal(human[2], '✔ md   2/2   30ms');
});

test('suite icon, name and count carry their tones', () => {
	const blocks = summaryBlocks(base(), {columns: 80, bars: false});
	const host = spansOf(blocks[1]!);
	assert.equal(host[0]?.tone, 'error');
	assert.equal(host.find(s => s.text === 'host')?.bold, true);
	assert.equal(toneOf(blocks[1]!, '10/10'), 'error');
	assert.equal(toneOf(blocks[1]!, '1.2s'), 'muted');
	assert.equal(spansOf(blocks[2]!)[0]?.tone, 'ok');
	assert.equal(toneOf(blocks[2]!, '2/2'), 'ok');
	assert.ok(spansOf(blocks[2]!).some(s => s.decor === true && /^ +$/.test(s.text)));
});

test('without colour only the muted dim sequence can appear, with colour only SGR sequences', () => {
	const blocks = summaryBlocks(base(), {columns: 80});
	assert.ok(!plainLines(blocks).join('\n').includes(ESC));
	const text = renderStyled(blocks, 80, {color: true});
	assert.ok(text.includes(ESC));
	assert.ok(!text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').includes(ESC));
});

test('bars are interleaved under their suite as non-decor lines with merged tone runs', () => {
	const blocks = summaryBlocks(base(), {columns: 80});
	assert.equal(blocks[2]?.kind, 'line');
	assert.notEqual((blocks[2] as {decor?: boolean}).decor, true);
	const bar = spansOf(blocks[2]!);
	assert.deepEqual(
		bar.map(s => s.tone),
		['error', 'ok'],
	);
	assert.equal(plainLines(blocks)[2], bar.map(s => s.text).join(''));
	assert.equal(plainLines(blocks)[3], '✔ md 2/2 30ms');
});

test('bars are left out when bars is false', () => {
	assert.equal(lines(base(), 80, false).length, 5);
});

test('more than 64 tone runs fold the rest into the last span, toned error when it holds a failure', () => {
	const states = Array.from({length: 8 * 100}, (_, i): DotState => (Math.floor(i / 8) % 2 === 0 ? 'pass' : 'skip'));
	states[8 * 99] = 'fail';
	const state = base({suites: [{name: 'big', planned: states.length, states, status: 'failed', failures: []}]});
	const bar = spansOf(summaryBlocks(state, {columns: 200})[2]!);
	assert.equal(bar.length, MAX_SPANS);
	assert.equal(bar.at(-1)?.tone, 'error');
	assert.equal(bar.map(s => s.text).join('').length, 100);
});

test('bars wrap at the width', () => {
	const out = lines(base({suites: [{name: 'big', planned: 400, states: Array<'pass'>(400).fill('pass'), status: 'passed', failures: []}]}), 11);
	assert.ok(out.slice(2).every(l => Array.from(l).length <= 10));
});

test('failure lines are toned and the more-failures line is warn', () => {
	const failures = Array.from({length: 53}, (_, i) => ({file: 'f', name: `t${i}`}));
	const blocks = summaryBlocks(base({suites: [{name: 'host', planned: 53, states: Array<'fail'>(53).fill('fail'), status: 'failed', failures}]}), {columns: 80, bars: false});
	const first = blocks[2]!;
	assert.equal(toneOf(first, '✖'), 'error');
	assert.equal(toneOf(first, 'f'), 'muted');
	assert.equal(toneOf(first, ' › '), 'muted');
	assert.equal(toneOf(blocks.at(-1)!, '+3 more failures'), 'warn');
});

test('control characters and bidi in test names are removed', () => {
	const state = base({suites: [{name: 'host', planned: 1, states: ['fail'], status: 'failed', failures: [{file: 'f', name: `bad${ESC}]0;title\u0007 name‮`, error: `x${ESC}[2Jy`}]}]});
	const text = lines(state).join('\n');
	assert.ok(!text.includes(ESC));
	assert.ok(!text.includes('‮'));
	assert.ok(!text.includes('\u0007'));
});

test('failures are capped at 50 with a count of the rest', () => {
	const failures = Array.from({length: 53}, (_, i) => ({file: 'f', name: `t${i}`}));
	const out = lines(base({suites: [{name: 'host', planned: 53, states: Array<'fail'>(53).fill('fail'), status: 'failed', failures}]}));
	assert.equal(out.filter(l => l.startsWith('✖ f › ')).length, 50);
	assert.equal(out.at(-1), '+3 more failures');
});
