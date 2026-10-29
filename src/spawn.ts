import {spawn, type ChildProcess} from 'node:child_process';

export type SpawnOptions = {
	cwd: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	timeoutMs?: number;
	onLine: (line: string) => void;
};

export type SpawnResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
};

export type SpawnFn = (args: string[], options: SpawnOptions) => Promise<SpawnResult>;

const MAX_LINE = 64 * 1024;
const STDERR_TAIL = 4 * 1024;
const KILL_GRACE_MS = 3000;
const SCRUBBED_ENV = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_TEST_CONTEXT', 'YENA_DEV_CHILD'];

const live = new Set<ChildProcess>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
		}
	}
}

export function killAll(): void {
	for (const child of live) killGroup(child, 'SIGKILL');
	live.clear();
}

export function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {...process.env, ...extra};
	for (const key of SCRUBBED_ENV) delete env[key];
	return env;
}

export const spawnNode: SpawnFn = (args, options) =>
	new Promise<SpawnResult>((resolve, reject) => {
		const {signal} = options;
		if (signal?.aborted) {
			resolve({code: null, signal: null, stderr: '', timedOut: false, aborted: true});
			return;
		}
		const child = spawn(process.execPath, args, {
			cwd: options.cwd,
			env: childEnv(options.env),
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		live.add(child);

		let stderr = '';
		let timedOut = false;
		let aborted = false;
		let killRequested = false;
		let killTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;

		const stop = (): void => {
			if (killRequested) return;
			killRequested = true;
			killGroup(child, 'SIGTERM');
			killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
		};
		const onAbort = (): void => {
			aborted = true;
			stop();
		};
		signal?.addEventListener('abort', onAbort, {once: true});
		if (options.timeoutMs !== undefined) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				stop();
			}, options.timeoutMs);
		}

		const emit = (raw: string): void => {
			const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
			try {
				options.onLine(line);
			} catch {
			}
		};
		let pending = '';
		let dropping = false;
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			let text = chunk;
			for (;;) {
				const nl = text.indexOf('\n');
				if (nl < 0) {
					if (!dropping) {
						pending += text;
						if (pending.length > MAX_LINE) {
							pending = '';
							dropping = true;
						}
					}
					return;
				}
				const head = text.slice(0, nl);
				text = text.slice(nl + 1);
				if (dropping) {
					dropping = false;
					continue;
				}
				const line = pending + head;
				pending = '';
				if (line.length <= MAX_LINE) emit(line);
			}
		});
		child.stdout.on('end', () => {
			if (!dropping && pending !== '') emit(pending);
			pending = '';
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderr = (stderr + chunk).slice(-STDERR_TAIL);
		});

		const cleanup = (): void => {
			clearTimeout(killTimer);
			clearTimeout(timeoutTimer);
			signal?.removeEventListener('abort', onAbort);
			live.delete(child);
		};
		child.once('error', err => {
			cleanup();
			reject(err);
		});
		child.once('close', (code, sig) => {
			if (killRequested) killGroup(child, 'SIGKILL');
			cleanup();
			resolve({code, signal: sig, stderr, timedOut, aborted});
		});
	});
