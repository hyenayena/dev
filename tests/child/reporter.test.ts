import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collect, reporterScript, suiteFixtures} from '../helpers.js';

type Line = {dev: number; kind: string; name: string; file: string; ms: number; error?: string};

const run = async () => {
	const result = await collect(
		['--import', 'tsx', '--test', `--test-reporter=${reporterScript}`, '--test-reporter-destination=stdout', 'basic.fixture.ts', 'grouped.fixture.ts'],
		suiteFixtures,
	);
	return result.lines;
};

test('emits one NDJSON record per test and nothing else', async () => {
	const lines = await run();
	assert.ok(!lines.some(l => l.includes('NOISE')));
	const records = lines.map(l => JSON.parse(l) as Line);
	assert.ok(records.every(r => r.dev === 1));
	assert.deepEqual(
		records.map(r => `${r.kind}:${r.name}`).sort(),
		['fail:fails', 'pass:one', 'pass:passes', 'pass:two', 'skip:skipped', 'todo:todo'],
	);
});

test('suites are excluded, files are relative, errors are one line', async () => {
	const records = (await run()).map(l => JSON.parse(l) as Line);
	assert.ok(!records.some(r => r.name === 'group'));
	assert.ok(records.every(r => r.file === 'basic.fixture.ts' || r.file === 'grouped.fixture.ts'));
	assert.equal(records.find(r => r.kind === 'fail')?.error, 'boom');
	assert.ok(records.every(r => typeof r.ms === 'number'));
});
