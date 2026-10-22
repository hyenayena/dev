import path from 'node:path';
import {fileURLToPath} from 'node:url';

type TestEvent = {
	type: string;
	data?: {
		name?: unknown;
		file?: unknown;
		skip?: unknown;
		todo?: unknown;
		details?: {type?: unknown; duration_ms?: unknown; error?: {message?: unknown; cause?: {message?: unknown}}};
	};
};

const MAX_ERROR = 500;

function firstLine(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const line = value.split('\n')[0] as string;
	return line.slice(0, MAX_ERROR);
}

function relativeFile(file: unknown): string {
	if (typeof file !== 'string') return '';
	const abs = file.startsWith('file:') ? fileURLToPath(file) : file;
	return path.relative(process.cwd(), abs);
}

export default async function* reporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
	for await (const event of source) {
		if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
		const data = event.data;
		if (!data || data.details?.type === 'suite') continue;
		const kind =
			event.type === 'test:fail' ? 'fail' : data.skip !== undefined && data.skip !== false ? 'skip' : data.todo !== undefined && data.todo !== false ? 'todo' : 'pass';
		const record: Record<string, unknown> = {
			dev: 1,
			kind,
			name: String(data.name ?? ''),
			file: relativeFile(data.file),
			ms: typeof data.details?.duration_ms === 'number' ? Math.round(data.details.duration_ms) : 0,
		};
		if (kind === 'fail') {
			const error = firstLine(data.details?.error?.cause?.message) ?? firstLine(data.details?.error?.message);
			if (error !== undefined) record.error = error;
		}
		yield `${JSON.stringify(record)}\n`;
	}
}
