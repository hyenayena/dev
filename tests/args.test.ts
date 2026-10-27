import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseDevArgs} from '../src/args.js';

test('suites, files and a name pattern, in any order and both flag spellings', () => {
	assert.deepEqual(parseDevArgs([]), {suites: [], files: []});
	assert.deepEqual(parseDevArgs(['claude', '--file', 'a.test.ts', 'host', '--file=b.test.ts', '--name', 'x y', 'claude', '--file', 'a.test.ts']), {
		suites: ['claude', 'host'],
		files: ['a.test.ts', 'b.test.ts'],
		name: 'x y',
	});
	assert.equal(parseDevArgs(['--name=^policy']).name, '^policy');
});

test('bad options are errors', () => {
	assert.throws(() => parseDevArgs(['--file']), {message: '--file needs a value'});
	assert.throws(() => parseDevArgs(['--file', '--name', 'x']), {message: '--file needs a value'});
	assert.throws(() => parseDevArgs(['--name', 'a', '--name', 'b']), {message: '--name is given twice'});
	assert.throws(() => parseDevArgs(['--name', 'x'.repeat(201)]), /1 to 200/);
	assert.throws(() => parseDevArgs(['--name', 'a' + String.fromCharCode(27)]), /1 to 200/);
	assert.throws(() => parseDevArgs(['-x']), {message: 'Unknown option: -x'});
	assert.throws(() => parseDevArgs(Array.from({length: 51}, (_, i) => `--file=f${i}.ts`)), {message: 'At most 50 files'});
});
