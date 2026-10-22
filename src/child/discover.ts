import {globSync} from 'node:fs';
import {registerHooks} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const shimUrl = new URL('./test-shim.ts', import.meta.url).href;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === 'node:test' && context.parentURL !== shimUrl) return {url: shimUrl, shortCircuit: true};
		return next(specifier, context);
	},
});

// Imported test files may leave async errors behind; discovery only needs the count.
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const shim = (await import(shimUrl)) as {discovery: {total: number}};
const cwd = process.cwd();
const files = new Set<string>();
for (const pattern of process.argv.slice(2)) {
	for (const match of globSync(pattern, {cwd})) {
		if (!match.split(/[\\/]/).includes('node_modules')) files.add(match);
	}
}

let total = 0;
for (const file of [...files].sort()) {
	const before = shim.discovery.total;
	try {
		await import(pathToFileURL(path.resolve(cwd, file)).href);
		total += Math.max(1, shim.discovery.total - before);
	} catch {
		total += 1;
	}
}

const line = JSON.stringify({dev: 1, kind: 'discovered', total, files: files.size});
process.stdout.write(`${line}\n`, () => process.exit(0));
