import assert from 'node:assert/strict';
import React from 'react';
import {test} from 'node:test';
import type {ViewHost} from '../../../../src/api.js';
import {createRunStore} from '../../src/store.js';
import {TestView} from '../../src/ui/TestView.js';
import {mountHarness} from './testkit.js';

function storeWith(phase: 'running' | 'done' = 'running') {
	const store = createRunStore();
	store.update(state => {
		state.phase = phase;
		state.suites = [
			{name: 'alpha', planned: 16, states: Array<'pass'>(5).fill('pass'), status: 'running', failures: []},
			{name: 'beta', planned: 4, states: [], status: 'pending', failures: []},
		];
	});
	return store;
}

test('renders the current store state', async () => {
	const h = mountHarness(<TestView store={storeWith()} abort={() => {}} />);
	await h.settle();
	const frame = h.lastFrame();
	assert.match(frame, /alpha 5\/16/);
	assert.match(frame, /beta 0\/4/);
	assert.match(frame, /Esc cancel/);
	h.unmount();
});

test('Esc and Ctrl+C abort while running', async () => {
	let aborted = 0;
	const h = mountHarness(<TestView store={storeWith()} abort={() => aborted++} />);
	await h.settle();
	h.press('\u001b');
	await h.settle();
	h.press('\u0003');
	await h.settle();
	assert.equal(aborted, 2);
	h.unmount();
});

test('an unfocused view ignores input, and host keys never abort', async () => {
	let aborted = 0;
	let focused = false;
	const host: ViewHost = {
		isFocused: () => focused,
		columns: () => 40,
		subscribe: () => () => {},
		move: () => false,
		isHostKey: () => true,
	};
	const h = mountHarness(<TestView store={storeWith()} abort={() => aborted++} host={host} />);
	await h.settle();
	h.press('\u001b');
	await h.settle();
	assert.equal(aborted, 0);
	focused = true;
	h.unmount();
	const again = mountHarness(<TestView store={storeWith()} abort={() => aborted++} host={host} />);
	await again.settle();
	again.press('\u001b');
	await again.settle();
	assert.equal(aborted, 0);
	again.unmount();
});

test('a remount after an unmount shows the current state', async () => {
	const store = storeWith();
	const first = mountHarness(<TestView store={store} abort={() => {}} />);
	await first.settle();
	first.unmount();
	store.update(state => {
		(state.suites[0] as {states: string[]}).states.push('pass', 'pass');
	});
	const second = mountHarness(<TestView store={store} abort={() => {}} />);
	await second.settle();
	assert.match(second.lastFrame(), /alpha 7\/16/);
	second.unmount();
});
