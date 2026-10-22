import test from 'node:test';

console.log('NOISE');
test('passes', () => {});
test('fails', () => {
	throw new Error('boom\nsecond');
});
test.skip('skipped', () => {});
test.todo('todo');
