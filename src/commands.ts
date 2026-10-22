import type {Command, Logger, MountControl, UiElement} from '../../../src/api.js';
import {runTests} from './runner.js';
import {spawnNode, type SpawnFn} from './spawn.js';
import {createRunStore, type RunStore} from './store.js';
import {findSuites, selectSuites} from './suites.js';
import {summaryLines} from './summary.js';
import {noopLog} from './log.js';

export type DevUi = {
	buildTestView(store: RunStore, abort: () => void, control: MountControl): UiElement;
	color(): boolean;
};

export type DevDeps = {
	root: string;
	log?: Logger;
	loadUi: () => Promise<DevUi>;
	spawn?: SpawnFn;
	onRun?: () => void;
};

const USAGE = 'dev test [suite]';
const FALLBACK_COLUMNS = 80;

export function createDevCommand(deps: DevDeps): Command {
	const log = deps.log ?? noopLog;
	let running = false;

	return {
		name: 'dev',
		description: 'Development tools',
		usage: USAGE,
		subcommands: [{name: 'test', usage: USAGE, description: 'Run the test suites with a live progress bar'}],
		async run(args, ctx) {
			const [sub, ...rest] = args;
			if (sub === undefined || sub === 'help') {
				ctx.print(`Usage: ${USAGE}\n  test  Run the test suites with a live progress bar`);
				return;
			}
			if (sub !== 'test') throw new Error(`Unknown subcommand: ${sub.slice(0, 64)}. Usage: ${USAGE}`);
			if (rest.length > 1) throw new Error(`Too many arguments. Usage: ${USAGE}`);
			if (running) throw new Error('A test run is already in progress');
			running = true;
			try {
				const suites = selectSuites(findSuites(deps.root, log), rest[0]);
				if (suites.length === 0) throw new Error('No test suites found');
				deps.onRun?.();

				const store = createRunStore();
				const controller = new AbortController();
				let view: MountControl | undefined;
				let shown: Promise<void> | undefined;
				let color = false;
				if (ctx.mount) {
					const ui = await deps.loadUi();
					color = ui.color();
					shown = ctx.mount(
						control => {
							view = control;
							return ui.buildTestView(store, () => controller.abort(), control);
						},
						{target: 'panel'},
					);
					shown.catch(err => log.warn('test view failed', {err}));
				} else {
					ctx.print(`Running ${suites.length} test suite${suites.length === 1 ? '' : 's'}...`);
				}

				const onAbort = (): void => controller.abort();
				if (ctx.signal?.aborted) onAbort();
				else ctx.signal?.addEventListener('abort', onAbort, {once: true});
				try {
					await runTests({suites, signal: controller.signal, store, log, spawn: deps.spawn ?? spawnNode});
				} finally {
					ctx.signal?.removeEventListener('abort', onAbort);
					view?.close();
					if (shown) await shown.catch(() => {});
				}
				const columns = view?.host?.columns() ?? FALLBACK_COLUMNS;
				ctx.print(summaryLines(store.get(), {columns, color}).join('\n'));
			} finally {
				running = false;
			}
		},
	};
}
