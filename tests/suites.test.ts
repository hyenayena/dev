import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import type {Logger} from '../../../src/api.js';
import {noopLog} from '../src/log.js';
import {findSuites, selectSuites} from '../src/suites.js';

const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'dev-suites-')));
after(() => rmSync(base, {recursive: true, force: true}));

const pkg = (script?: string): string => JSON.stringify(script === undefined ? {} : {scripts: {test: script}});
const SCRIPT = 'node --test "t/*.test.ts"';

function makeTree(): string {
	const root = path.join(base, `root-${Math.random().toString(36).slice(2)}`);
	mkdirSync(path.join(root, 'modules'), {recursive: true});
	writeFileSync(path.join(root, 'package.json'), pkg(SCRIPT));
	const module = (name: string, content: string): string => {
		const dir = path.join(root, 'modules', name);
		mkdirSync(dir, {recursive: true});
		writeFileSync(path.join(dir, 'package.json'), content);
		return dir;
	};
	module('zeta', pkg(SCRIPT));
	module('alpha', pkg(SCRIPT));
	module('noscript', pkg());
	module('Bad_Name', pkg(SCRIPT));
	module('.staging-1', pkg(SCRIPT));
	module('broken', '{not json');
	module('big', JSON.stringify({scripts: {test: SCRIPT}, pad: 'x'.repeat(70 * 1024)}));
	const linked = path.join(root, 'modules', 'linked');
	mkdirSync(linked);
	writeFileSync(path.join(base, 'real-package.json'), pkg(SCRIPT));
	symlinkSync(path.join(base, 'real-package.json'), path.join(linked, 'package.json'));
	const outside = path.join(base, 'outside');
	mkdirSync(outside, {recursive: true});
	writeFileSync(path.join(outside, 'package.json'), pkg(SCRIPT));
	symlinkSync(outside, path.join(root, 'modules', 'escape'));
	return root;
}

test('host comes first, modules are sorted, unusable ones are skipped with a warning', () => {
	const warned: string[] = [];
	const log: Logger = {...noopLog, warn: (_m, fields) => void warned.push(String((fields as {suite?: string}).suite))};
	const suites = findSuites(makeTree(), log);
	assert.deepEqual(
		suites.map(s => s.name),
		['host', 'alpha', 'zeta'],
	);
	assert.equal(suites[1]?.script, SCRIPT);
	assert.deepEqual(warned.sort(), ['big', 'broken', 'escape', 'linked']);
});

test('selectSuites returns all, one, or throws with the known names', () => {
	const all = findSuites(makeTree());
	assert.equal(selectSuites(all).length, 3);
	assert.deepEqual(
		selectSuites(all, 'zeta').map(s => s.name),
		['zeta'],
	);
	assert.throws(() => selectSuites(all, 'nope'), {message: 'Unknown test suite: nope. Known: host, alpha, zeta'});
});

test('the unknown name in the message is sanitised', () => {
	const all = findSuites(makeTree());
	const esc = String.fromCharCode(27);
	assert.throws(
		() => selectSuites(all, `a${esc}[31mb‮c`),
		(err: Error) => !err.message.includes(esc) && !err.message.includes('‮'),
	);
});

test('a module directory named host never shadows the root suite', () => {
	const root = makeTree();
	mkdirSync(path.join(root, 'modules', 'host'));
	writeFileSync(path.join(root, 'modules', 'host', 'package.json'), pkg(SCRIPT));
	const hosts = findSuites(root).filter(s => s.name === 'host');
	assert.equal(hosts.length, 1);
	assert.equal(hosts[0]?.dir, realpathSync(root));
});
