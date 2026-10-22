import type {DotState} from './kit.js';

export type SuiteStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';

export type Failure = {file: string; name: string; error?: string};

export type SuiteState = {
	name: string;
	planned: number;
	states: DotState[];
	status: SuiteStatus;
	failures: Failure[];
	ms?: number;
	note?: string;
};

export type RunPhase = 'discovering' | 'running' | 'done' | 'cancelled';

export type RunState = {
	phase: RunPhase;
	startedAt: number;
	endedAt?: number;
	suites: SuiteState[];
};

export type RunStore = {
	get(): RunState;
	subscribe(listener: () => void): () => void;
	update(mutate: (state: RunState) => void): void;
	flush(): void;
};

const THROTTLE_MS = 50;

const copy = (state: RunState): RunState => ({
	...state,
	suites: state.suites.map(s => ({...s, states: s.states.slice(), failures: s.failures.slice()})),
});

/** Lives outside React: the panel toggle unmounts the view, a remount reads the current state. */
export function createRunStore(now: () => number = Date.now): RunStore {
	const state: RunState = {phase: 'discovering', startedAt: now(), suites: []};
	const listeners = new Set<() => void>();
	let version = 0;
	let snapshotVersion = -1;
	let snapshot = copy(state);
	let timer: NodeJS.Timeout | undefined;

	const notify = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// a faulty subscriber must not stop the others
			}
		}
	};

	return {
		get() {
			if (snapshotVersion !== version) {
				snapshot = copy(state);
				snapshotVersion = version;
			}
			return snapshot;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		update(mutate) {
			mutate(state);
			version++;
			if (!timer) {
				timer = setTimeout(notify, THROTTLE_MS);
				timer.unref();
			}
		},
		flush: notify,
	};
}
