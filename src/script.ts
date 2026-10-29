export type TestScript = {nodeArgs: string[]; testArgs: string[]; globs: string[]};

export const METACHARACTERS = /[;|&<>$`\\(){}\n\r]/;

export function tokenize(script: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let started = false;
	let quote: string | undefined;
	for (const ch of script) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
		} else if (ch === ' ' || ch === '\t') {
			if (started) tokens.push(current);
			current = '';
			started = false;
		} else if (ch === '*' || ch === '?' || ch === '[') {
			throw new Error('unquoted glob');
		} else {
			current += ch;
			started = true;
		}
	}
	if (quote) throw new Error('unterminated quote');
	if (started) tokens.push(current);
	return tokens;
}

export function parseTestScript(script: string): TestScript {
	if (METACHARACTERS.test(script)) throw new Error('shell metacharacter');
	const tokens = tokenize(script);
	if (tokens[0] !== 'node') throw new Error('not a node command');
	const nodeArgs: string[] = [];
	const testArgs: string[] = [];
	const globs: string[] = [];
	let seenTest = false;
	for (const token of tokens.slice(1)) {
		if (token.startsWith('--test-reporter')) throw new Error('reporter flag');
		if (token === '--test') {
			if (seenTest) throw new Error('duplicate --test');
			seenTest = true;
		} else if (!seenTest) {
			nodeArgs.push(token);
		} else if (token.startsWith('--test-')) {
			testArgs.push(token);
		} else if (token.startsWith('-') || token === '') {
			throw new Error('unsupported flag');
		} else {
			globs.push(token);
		}
	}
	if (!seenTest || globs.length === 0) throw new Error('missing --test or globs');
	return {nodeArgs, testArgs, globs};
}
