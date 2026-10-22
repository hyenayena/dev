import {fileURLToPath} from 'node:url';
import {spawnNode, type SpawnResult} from '../src/spawn.js';

export const suiteFixtures = fileURLToPath(new URL('./fixtures/suite/', import.meta.url));
export const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const discoverScript = fileURLToPath(new URL('../src/child/discover.ts', import.meta.url));
export const reporterScript = fileURLToPath(new URL('../src/child/reporter.ts', import.meta.url));

export async function collect(args: string[], cwd: string, env?: Record<string, string | undefined>): Promise<SpawnResult & {lines: string[]}> {
	const lines: string[] = [];
	const result = await spawnNode(args, {cwd, ...(env ? {env} : {}), onLine: line => lines.push(line)});
	return {...result, lines};
}

export const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// A killed process stays visible as a zombie until its reaper (PID 1 in the container) collects it.
export async function waitGone(pids: number[], timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (pids.some(alive) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
	return !pids.some(alive);
}
