import {mock, snapshot} from 'node:test';

export const discovery = {total: 0};

type Registrar = ((...args: unknown[]) => Promise<void>) & {
	skip: Registrar;
	todo: Registrar;
	only: Registrar;
};

function makeTest(): Registrar {
	const fn = (): Promise<void> => {
		discovery.total++;
		return Promise.resolve();
	};
	return Object.assign(fn, {skip: fn, todo: fn, only: fn}) as unknown as Registrar;
}

function makeSuite(): Registrar {
	const fn = (...args: unknown[]): Promise<void> => {
		const body = args.find(a => typeof a === 'function') as (() => unknown) | undefined;
		try {
			Promise.resolve(body?.()).catch(() => {});
		} catch {
		}
		return Promise.resolve();
	};
	return Object.assign(fn, {skip: fn, todo: fn, only: fn}) as unknown as Registrar;
}

export const test = makeTest();
export const it = test;
export const describe = makeSuite();
export const suite = describe;
const noop = (): void => {};
export const before = noop;
export const after = noop;
export const beforeEach = noop;
export const afterEach = noop;
export {mock, snapshot};
export default test;
