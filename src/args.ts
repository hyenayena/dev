export type DevArgs = {
	suites: string[];
	files: string[];
	name?: string;
};

const MAX_FILES = 50;
const MAX_NAME = 200;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]');

const takeValue = (flag: string, args: string[], i: number): [string, number] => {
	const arg = args[i] as string;
	const eq = arg.indexOf('=');
	if (eq !== -1) return [arg.slice(eq + 1), i];
	const next = args[i + 1];
	if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
	return [next, i + 1];
};

export function parseDevArgs(args: string[]): DevArgs {
	const out: DevArgs = {suites: [], files: []};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === '--file' || arg.startsWith('--file=')) {
			const [value, at] = takeValue('--file', args, i);
			i = at;
			if (value === '' || CONTROL.test(value)) throw new Error('--file needs a path');
			if (out.files.length >= MAX_FILES) throw new Error(`At most ${MAX_FILES} files`);
			if (!out.files.includes(value)) out.files.push(value);
		} else if (arg === '--name' || arg.startsWith('--name=')) {
			const [value, at] = takeValue('--name', args, i);
			i = at;
			if (value === '' || value.length > MAX_NAME || CONTROL.test(value)) throw new Error(`--name needs a pattern of 1 to ${MAX_NAME} characters`);
			if (out.name !== undefined) throw new Error('--name is given twice');
			out.name = value;
		} else if (arg.startsWith('-')) {
			throw new Error(`Unknown option: ${arg.slice(0, 32)}`);
		} else if (!out.suites.includes(arg)) {
			out.suites.push(arg);
		}
	}
	return out;
}
