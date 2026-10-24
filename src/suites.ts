import {lstatSync, readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import type {Logger} from '../../../src/api.js';
import {sanitizeText} from './kit.js';
import {noopLog} from './log.js';

export type Suite = {name: string; dir: string; script: string};

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGE_JSON = 64 * 1024;

function inside(root: string, target: string): boolean {
	return target === root || target.startsWith(root + path.sep);
}

export type ScriptKey = 'test' | 'typecheck';

// Undefined: nothing to run (no package.json or no such script). Throws: unreadable or unsafe.
function readScript(dir: string, key: ScriptKey): string | undefined {
	const file = path.join(dir, 'package.json');
	let info;
	try {
		info = lstatSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
	if (!info.isFile()) throw new Error('package.json is not a regular file');
	if (info.size > MAX_PACKAGE_JSON) throw new Error('package.json is too large');
	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
	const scripts = (parsed as {scripts?: unknown} | null)?.scripts;
	const script = (scripts as Record<string, unknown> | null | undefined)?.[key];
	return typeof script === 'string' ? script : undefined;
}

export function findSuites(root: string, log: Logger = noopLog, key: ScriptKey = 'test'): Suite[] {
	const realRoot = realpathSync(root);
	const suites: Suite[] = [];
	const add = (name: string, dir: string): void => {
		try {
			const real = realpathSync(dir);
			if (!inside(realRoot, real)) throw new Error('directory leaves the yena root');
			if (!statSync(real).isDirectory()) return;
			const script = readScript(real, key);
			if (script !== undefined) suites.push({name, dir: real, script});
		} catch (err) {
			log.warn('suite skipped', {suite: name, err});
		}
	};
	add('host', realRoot);
	let names: string[] = [];
	try {
		names = readdirSync(path.join(realRoot, 'modules')).filter(n => NAME.test(n) && n !== 'host');
	} catch (err) {
		log.warn('modules directory unreadable', {err});
	}
	for (const name of names.sort()) add(name, path.join(realRoot, 'modules', name));
	return suites;
}

export function selectSuites(all: Suite[], name?: string): Suite[] {
	if (name === undefined) return all;
	const found = all.filter(s => s.name === name);
	if (found.length > 0) return found;
	throw new Error(`Unknown test suite: ${sanitizeText(name, 64)}. Known: ${all.map(s => s.name).join(', ')}`);
}
