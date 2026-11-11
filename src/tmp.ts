import {lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Logger} from '../../../src/api.js';
import {noopLog} from './log.js';

export const TMP_PREFIX = 'yena-dev-';
export const HEARTBEAT_MS = 60_000;
export const STALE_MS = 15 * 60_000;

const live = new Set<string>();

export function makeTempDir(): string {
	const dir = mkdtempSync(path.join(realpathSync(tmpdir()), TMP_PREFIX));
	live.add(dir);
	return dir;
}

export function removeTempDir(dir: string): void {
	live.delete(dir);
	let real: string;
	try {
		real = realpathSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw err;
	}
	const root = realpathSync(tmpdir());
	if (path.dirname(real) !== root || !path.basename(real).startsWith(TMP_PREFIX)) return;
	rmSync(real, {recursive: true, force: true});
}

export function removeLiveTempDirs(): void {
	for (const dir of [...live]) {
		try {
			removeTempDir(dir);
		} catch {
			// exit hook: nothing left to report to
		}
	}
}

export function startHeartbeat(everyMs = HEARTBEAT_MS): () => void {
	const timer = setInterval(() => {
		const now = new Date();
		for (const dir of live) {
			try {
				utimesSync(dir, now, now);
			} catch {
				// a removed dir needs no heartbeat
			}
		}
	}, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}

export function sweepStaleTempDirs(opts: {root?: string; now?: number; staleMs?: number; log?: Logger} = {}): number {
	const log = opts.log ?? noopLog;
	const now = opts.now ?? Date.now();
	const staleMs = opts.staleMs ?? STALE_MS;
	let entries: string[];
	let root: string;
	try {
		root = opts.root ?? realpathSync(tmpdir());
		entries = readdirSync(root);
	} catch (err) {
		log.warn('stale temp dir sweep failed', {err});
		return 0;
	}
	const uid = process.getuid?.();
	let removed = 0;
	let failed = 0;
	let lastErr: unknown;
	for (const entry of entries) {
		if (!entry.startsWith(TMP_PREFIX)) continue;
		const p = path.join(root, entry);
		try {
			const st = lstatSync(p);
			if (!st.isDirectory() || st.isSymbolicLink()) continue;
			if (uid !== undefined && st.uid !== uid) continue;
			if (now - st.mtimeMs <= staleMs) continue;
			if (live.has(p)) continue;
			rmSync(p, {recursive: true, force: true});
			removed++;
		} catch (err) {
			failed++;
			lastErr = err;
		}
	}
	if (failed > 0) log.warn('stale temp dir sweep failed', {failed, err: lastErr});
	return removed;
}
