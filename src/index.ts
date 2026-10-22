import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ModulePlugin} from '../../../src/api.js';
import {createDevCommand, type DevUi} from './commands.js';
import {noopLog} from './log.js';
import {killAll} from './spawn.js';

let exitHookInstalled = false;

// Lazy import: nothing but a test run loads React or Ink.
const loadUi = (): Promise<DevUi> => import('./ui/mount.js').then(m => ({buildTestView: m.buildTestView, color: m.color}));

const plugin: ModulePlugin = host => {
	const log = host.log ?? noopLog;
	const moduleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
	const root = realpathSync(path.resolve(moduleDir, '..', '..'));
	if (!existsSync(path.join(root, 'package.json')) || !existsSync(path.join(root, 'modules'))) {
		throw new Error('dev must be installed inside a yena checkout');
	}
	log.info('plugin loaded');
	return [
		createDevCommand({
			root,
			log,
			loadUi,
			onRun: () => {
				if (exitHookInstalled) return;
				exitHookInstalled = true;
				process.once('exit', killAll);
			},
		}),
	];
};

export default plugin;
