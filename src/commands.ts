import type {Command, CommandContext, Logger, MountControl, UiElement} from '../../../src/api.js';
import {formatDuration} from './format.js';
import {sanitizeText} from './kit.js';
import {runTests} from './runner.js';
import {spawnNode, type SpawnFn} from './spawn.js';
import {createRunStore, type RunStore} from './store.js';
import {findSuites, selectSuites, type Suite} from './suites.js';
import {summaryLines} from './summary.js';
import {runTypecheck, type TypecheckResult} from './typecheck.js';
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

const USAGE = 'dev test|typecheck|check [suite]';
const HELP = [
	`Usage: ${USAGE}`,
	'  test       Run the test suites with a live progress bar',
	'  typecheck  Typecheck the suites with tsc',
	'  check      Typecheck, then run the tests if the typecheck passed',
].join('\n');
const FALLBACK_COLUMNS = 80;
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SUBCOMMANDS = ['test', 'typecheck', 'check'] as const;
type Sub = (typeof SUBCOMMANDS)[number];

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function typecheckLines(result: TypecheckResult): string[] {
	const icon = result.status === 'ok' ? '✔' : result.status === 'cancelled' ? '·' : '✖';
	const parts = [`${icon} ${sanitizeText(result.name, 64)} typecheck`];
	if (result.errors > 0) parts.push(plural(result.errors, 'error'));
	if (result.status === 'cancelled') parts.push('cancelled');
	if (result.note) parts.push(sanitizeText(result.note, 300));
	parts.push(formatDuration(result.ms));
	const lines = [parts.join(' · ')];
	for (const line of result.lines) lines.push(`  ${line}`);
	if (result.errors > result.lines.length) lines.push(`  +${result.errors - result.lines.length} more errors`);
	return lines;
}

// Children run in their own process groups, so a terminal Ctrl+C or a hangup would not reach them.
function abortOnSignals(controller: AbortController): () => void {
	const handler = (): void => controller.abort();
	for (const sig of SIGNALS) process.once(sig, handler);
	return () => {
		for (const sig of SIGNALS) process.off(sig, handler);
	};
}

export function createDevCommand(deps: DevDeps): Command {
	const log = deps.log ?? noopLog;
	let running = false;

	const typecheckPhase = async (suites: Suite[], controller: AbortController, ctx: CommandContext): Promise<number> => {
		ctx.print(`Typechecking ${plural(suites.length, 'suite')}...`);
		const started = Date.now();
		const results = await runTypecheck({
			suites,
			root: deps.root,
			signal: controller.signal,
			spawn: deps.spawn ?? spawnNode,
			log,
			onSuite: result => ctx.print(typecheckLines(result).join('\n')),
		});
		const passed = results.filter(r => r.status === 'ok').length;
		const cancelled = results.filter(r => r.status === 'cancelled').length;
		const failed = results.length - passed - cancelled;
		ctx.print(`Typecheck: ${passed}/${results.length} passed · ${failed} failed${cancelled ? ` · ${cancelled} cancelled` : ''} · ${formatDuration(Date.now() - started)}`);
		return results.length - passed;
	};

	const testPhase = async (suites: Suite[], controller: AbortController, ctx: CommandContext): Promise<number> => {
		const store = createRunStore();
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
			ctx.print(`Running ${plural(suites.length, 'test suite')}...`);
		}
		try {
			await runTests({suites, signal: controller.signal, store, log, spawn: deps.spawn ?? spawnNode});
		} finally {
			view?.close();
			if (shown) await shown.catch(() => {});
		}
		const columns = view?.host?.columns() ?? FALLBACK_COLUMNS;
		const state = store.get();
		ctx.print(summaryLines(state, {columns, color}).join('\n'));
		const bad = state.suites.filter(s => s.status !== 'passed').length;
		return state.phase === 'cancelled' ? Math.max(1, bad) : bad;
	};

	return {
		name: 'dev',
		description: 'Development tools',
		usage: USAGE,
		subcommands: [
			{name: 'test', usage: USAGE, description: 'Run the test suites with a live progress bar'},
			{name: 'typecheck', usage: USAGE, description: 'Typecheck the suites with tsc'},
			{name: 'check', usage: USAGE, description: 'Typecheck, then run the tests if the typecheck passed'},
		],
		async run(args, ctx) {
			const [sub, ...rest] = args;
			if (sub === undefined || sub === 'help') {
				ctx.print(HELP);
				return;
			}
			if (!(SUBCOMMANDS as readonly string[]).includes(sub)) throw new Error(`Unknown subcommand: ${sub.slice(0, 64)}. Usage: ${USAGE}`);
			const mode = sub as Sub;
			if (rest.length > 1) throw new Error(`Too many arguments. Usage: ${USAGE}`);
			if (running) throw new Error('A dev run is already in progress');
			running = true;
			let removeSignals: (() => void) | undefined;
			try {
				const typecheckSuites = mode === 'test' ? [] : selectSuites(findSuites(deps.root, log, 'typecheck'), rest[0]);
				const testSuites = mode === 'typecheck' ? [] : selectSuites(findSuites(deps.root, log), rest[0]);
				if (mode !== 'test' && typecheckSuites.length === 0) throw new Error('No typecheck suites found');
				if (mode !== 'typecheck' && testSuites.length === 0) throw new Error('No test suites found');

				deps.onRun?.();
				const controller = new AbortController();
				if (ctx.headless) removeSignals = abortOnSignals(controller);
				const onAbort = (): void => controller.abort();
				if (ctx.signal?.aborted) onAbort();
				else ctx.signal?.addEventListener('abort', onAbort, {once: true});

				let failed = 0;
				try {
					if (mode !== 'test') failed += await typecheckPhase(typecheckSuites, controller, ctx);
					if (mode !== 'typecheck') {
						if (failed > 0) ctx.print('Tests skipped: the typecheck did not pass');
						else failed += await testPhase(testSuites, controller, ctx);
					}
				} finally {
					ctx.signal?.removeEventListener('abort', onAbort);
				}
				if (ctx.headless && failed > 0) throw new Error(`${plural(failed, 'suite')} failed`);
			} finally {
				removeSignals?.();
				running = false;
			}
		},
	};
}
