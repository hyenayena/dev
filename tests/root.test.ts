import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {isReadOnlyDir, targetRoot} from '../src/root.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dev-root-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const image = path.join(tmp, 'app');
const copy = path.join(tmp, 'workplace', 'yena');
for (const dir of [image, copy]) {
	mkdirSync(path.join(dir, 'modules'), {recursive: true});
	writeFileSync(path.join(dir, 'package.json'), '{}');
}
const build = (workCopy?: string) => ({version: '0.1.0', modules: [], root: {mode: 'image' as const, path: image, ...(workCopy && {workCopy})}});

test('a writable own root is checked as is (a bind-mounted checkout, or the working copy in dev mode)', () => {
	assert.equal(targetRoot(image, build(copy), () => false), image);
});

test('the read-only image checks the working copy the host names', () => {
	assert.equal(targetRoot(image, build(copy), () => true), copy);
});

test('without a working copy, or on an old host, the read-only image is an error', () => {
	assert.throws(() => targetRoot(image, build(path.join(tmp, 'missing')), () => true), /No yena working copy in .*missing/);
	assert.throws(() => targetRoot(image, build(), () => true), /names no working copy; update the host/);
	assert.throws(() => targetRoot(image, undefined, () => true), /update the host/);
});

test('isReadOnlyDir: a writable or missing dir is not read-only', () => {
	assert.equal(isReadOnlyDir(tmp), false);
	assert.equal(isReadOnlyDir(path.join(tmp, 'nope')), false);
});
