import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {collect, discoverScript, reporterScript, suiteFixtures} from '../helpers.js';

const work = mkdtempSync(path.join(tmpdir(), 'dev-discover-'));
after(() => rmSync(work, {recursive: true, force: true}));

const tsx = ['--import', 'tsx'];

test('the discovered count equals the number of results of a real run', async () => {
	const tmp = mkdtempSync(path.join(work, 't-'));
	const discovered = await collect([...tsx, discoverScript, '*.fixture.ts'], suiteFixtures, {TMPDIR: tmp, DEV_SENTINEL: path.join(work, 'discover-sentinel')});
	const record = JSON.parse(discovered.lines.at(-1) as string) as {dev: number; kind: string; total: number; files: number};
	assert.equal(record.dev, 1);
	assert.equal(record.kind, 'discovered');
	assert.equal(record.files, 4);

	const real = await collect(
		[...tsx, '--test', `--test-reporter=${reporterScript}`, '--test-reporter-destination=stdout', '*.fixture.ts'],
		suiteFixtures,
		{DEV_SENTINEL: path.join(work, 'real-sentinel')},
	);
	const results = real.lines.filter(l => l.startsWith('{"dev":1'));
	assert.equal(record.total, results.length);
	assert.equal(record.total, 8);
});

test('discovery never runs a test body', async () => {
	const sentinel = path.join(work, 'sentinel-check');
	await collect([...tsx, discoverScript, '*.fixture.ts'], suiteFixtures, {TMPDIR: work, DEV_SENTINEL: sentinel});
	assert.equal(existsSync(sentinel), false);
});

test('top-level temp files land in TMPDIR', async () => {
	const tmp = mkdtempSync(path.join(work, 'tmpdir-'));
	await collect([...tsx, discoverScript, 'grouped.fixture.ts'], suiteFixtures, {TMPDIR: tmp});
	assert.ok(readdirSync(tmp).some(name => name.startsWith('devfx-')));
});

test('an empty file and a file that fails to import count as one each', async () => {
	const result = await collect([...tsx, discoverScript, 'empty.fixture.ts', 'broken.fixture.ts'], suiteFixtures, {TMPDIR: work});
	assert.deepEqual(JSON.parse(result.lines.at(-1) as string), {dev: 1, kind: 'discovered', total: 2, files: 2});
});
