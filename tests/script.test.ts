import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {parseTestScript} from '../src/script.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('every real test script of the checkout parses', () => {
	const dirs = ['', 'modules/core', 'modules/claude', 'modules/md', 'modules/dev'];
	let checked = 0;
	for (const dir of dirs) {
		const file = path.join(root, dir, 'package.json');
		if (!existsSync(file)) continue;
		const script = (JSON.parse(readFileSync(file, 'utf8')) as {scripts?: {test?: string}}).scripts?.test;
		if (typeof script !== 'string') continue;
		const parsed = parseTestScript(script);
		assert.ok(parsed.globs.length > 0, dir);
		checked++;
	}
	assert.ok(checked >= 2);
});

test('splits node flags, test flags and globs', () => {
	assert.deepEqual(parseTestScript(`node --import tsx --test --test-concurrency=1 "tests/**/*.test.ts" 'a/*.ts'`), {
		nodeArgs: ['--import', 'tsx'],
		testArgs: ['--test-concurrency=1'],
		globs: ['tests/**/*.test.ts', 'a/*.ts'],
	});
});

test('rejects what it cannot run safely', () => {
	const bad = [
		'node --test "a" ; rm -rf x',
		'node --test "a" | cat',
		'node --test "a" && echo',
		'node --test "$HOME/a"',
		'node --test "a" > out',
		'node --test `id`',
		'node --test "a\nb"',
		'node --test (a)',
		'node --test tests/*.test.ts',
		'node --test tests/?.ts',
		'node --test tests/[ab].ts',
		'node --test --test-reporter=spec "a"',
		'node --test --test-reporter spec "a"',
		'node --import tsx "a"',
		'node --test',
		'node --test --test "a"',
		'node --test "a',
		'tsx --test "a"',
		'npm test',
		'',
	];
	for (const script of bad) assert.throws(() => parseTestScript(script), Error, JSON.stringify(script));
});
