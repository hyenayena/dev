import {accessSync, constants, existsSync, realpathSync} from 'node:fs';
import path from 'node:path';
import type {BuildInfo} from '../../../src/api.js';

/** True only for a read-only filesystem (EROFS): the image; permissions do not count, the container runs as root. */
export function isReadOnlyDir(dir: string): boolean {
	try {
		accessSync(dir, constants.W_OK);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EROFS';
	}
}

/**
 * The yena root dev checks: its own (a writable checkout, or the working copy in dev mode), or, when that
 * is the read-only image, the working copy the host names (`BuildInfo.root.workCopy`, `/workplace/yena`).
 */
export function targetRoot(ownRoot: string, build: BuildInfo | undefined, readOnly: (dir: string) => boolean = isReadOnlyDir): string {
	if (!readOnly(ownRoot)) return ownRoot;
	const copy = build?.root?.workCopy;
	if (!copy) throw new Error(`${ownRoot} is the read-only image and the host names no working copy; update the host`);
	if (!existsSync(path.join(copy, 'package.json')) || !existsSync(path.join(copy, 'modules'))) {
		throw new Error(`No yena working copy in ${copy}`);
	}
	return realpathSync(copy);
}
