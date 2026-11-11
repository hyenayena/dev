import assert from 'node:assert/strict';
import {existsSync, lutimesSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import type {Logger} from '../../../src/api.js';
import {noopLog} from '../src/log.js';
import {makeTempDir, removeLiveTempDirs, removeTempDir, startHeartbeat, sweepStaleTempDirs} from '../src/tmp.js';

const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'dev-tmp-')));
const savedTmpdir = process.env.TMPDIR;
process.env.TMPDIR = work;
after(() => {
	if (savedTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = savedTmpdir;
	rmSync(work, {recursive: true, force: true});
});

const old = (p: string): void => {
	const t = new Date(Date.now() - 20 * 60_000);
	utimesSync(p, t, t);
};
const freshRoot = (): string => mkdtempSync(path.join(work, 'root-'));

test('the sweep removes old yena-dev dirs with their contents and keeps everything else', () => {
	const root = freshRoot();
	const outside = mkdtempSync(path.join(work, 'outside-'));
	old(outside);
	mkdirSync(path.join(root, 'yena-dev-old'));
	writeFileSync(path.join(root, 'yena-dev-old', 'f'), 'x');
	old(path.join(root, 'yena-dev-old'));
	mkdirSync(path.join(root, 'yena-dev-new'));
	mkdirSync(path.join(root, 'other-old'));
	old(path.join(root, 'other-old'));
	writeFileSync(path.join(root, 'yena-dev-file'), 'x');
	old(path.join(root, 'yena-dev-file'));
	symlinkSync(outside, path.join(root, 'yena-dev-link'));
	lutimesSync(path.join(root, 'yena-dev-link'), new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 20 * 60_000));

	assert.equal(sweepStaleTempDirs({root}), 1);
	assert.equal(existsSync(path.join(root, 'yena-dev-old')), false);
	for (const kept of ['yena-dev-new', 'other-old', 'yena-dev-file', 'yena-dev-link']) assert.ok(existsSync(path.join(root, kept)), kept);
	assert.ok(existsSync(outside));
});

test('an unreadable root is logged and returns 0', () => {
	const warns: string[] = [];
	const log: Logger = {...noopLog, warn: msg => void warns.push(msg)};
	assert.equal(sweepStaleTempDirs({root: path.join(work, 'missing'), log}), 0);
	assert.equal(warns.length, 1);
});

test('a live temp dir is never swept, and the heartbeat refreshes its mtime', async () => {
	const dir = makeTempDir();
	const stop = startHeartbeat(20);
	try {
		old(dir);
		sweepStaleTempDirs({root: path.dirname(dir)});
		assert.ok(existsSync(dir));
		const before = statSync(dir).mtimeMs;
		for (let i = 0; i < 50 && statSync(dir).mtimeMs === before; i++) await new Promise(r => setTimeout(r, 20));
		assert.ok(Date.now() - statSync(dir).mtimeMs < 60_000);
	} finally {
		stop();
		removeTempDir(dir);
	}
});

test('after stop the heartbeat no longer touches the dir', async () => {
	const dir = makeTempDir();
	try {
		const stop = startHeartbeat(20);
		stop();
		old(dir);
		const before = statSync(dir).mtimeMs;
		await new Promise(r => setTimeout(r, 80));
		assert.equal(statSync(dir).mtimeMs, before);
	} finally {
		removeTempDir(dir);
	}
});

test('removeTempDir refuses foreign paths and tolerates a second call', () => {
	const foreign = mkdtempSync(path.join(freshRoot(), 'yena-dev-'));
	removeTempDir(foreign);
	assert.ok(existsSync(foreign));
	const wrongName = mkdtempSync(path.join(realpathSync(tmpdir()), 'dev-tmp-x-'));
	try {
		removeTempDir(wrongName);
		assert.ok(existsSync(wrongName));
	} finally {
		rmSync(wrongName, {recursive: true, force: true});
	}
	const dir = makeTempDir();
	removeTempDir(dir);
	assert.equal(existsSync(dir), false);
	assert.doesNotThrow(() => removeTempDir(dir));
});

test('removeLiveTempDirs removes every live dir', () => {
	const dirs = [makeTempDir(), makeTempDir()];
	removeLiveTempDirs();
	for (const dir of dirs) assert.equal(existsSync(dir), false);
});
