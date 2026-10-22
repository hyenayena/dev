import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';

const dir = mkdtempSync(path.join(tmpdir(), 'devfx-'));
after(() => rmSync(dir, {recursive: true, force: true}));

describe('group', () => {
	it('one', () => {});
	it('two', () => {
		if (process.env.DEV_SENTINEL) writeFileSync(process.env.DEV_SENTINEL, 'ran');
	});
});
