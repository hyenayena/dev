import React, {useSyncExternalStore} from 'react';
import {Box, Text, useInput} from 'ink';
import type {ViewHost} from '../../../../src/api.js';
import {BrailleBar, SPINNERS, useSpinnerFrame, useViewHost} from './kit.js';
import {layoutRun, SPINNER_ICON} from '../layout.js';
import type {RunStore} from '../store.js';

const TONE = {
	plain: {},
	dim: {dimColor: true},
	add: {color: 'green'},
	del: {color: 'red'},
	warn: {color: 'yellow'},
	info: {color: 'cyan'},
} as const;

export type TestViewProps = {store: RunStore; abort: () => void; host?: ViewHost; rows?: number};

export function TestView({store, abort, host, rows}: TestViewProps) {
	const state = useSyncExternalStore(store.subscribe, store.get);
	const {focused, columns} = useViewHost(host);
	const active = state.phase === 'discovering' || state.phase === 'running';
	const frame = useSpinnerFrame(SPINNERS.braille, 80, active);

	useInput(
		(input, key) => {
			if (host?.isHostKey(input, key)) return;
			if (key.escape || (key.ctrl && input === 'c')) abort();
		},
		{isActive: focused && active},
	);

	const available = host?.rows?.() ?? rows ?? 24;
	const layout = layoutRun(state, columns, available);
	return (
		<Box flexDirection="column">
			{layout.map((row, i) => {
				if (row.kind === 'bar') {
					return <BrailleBar key={i} states={row.states} width={row.width} {...(row.maxRows === undefined ? {} : {maxRows: row.maxRows})} focus={row.focus} />;
				}
				if (row.kind === 'header') {
					const icon = row.icon === SPINNER_ICON ? frame : row.icon;
					return (
						<Text key={i} wrap="truncate" {...TONE[row.tone]}>
							{`${icon} ${row.text}`}
						</Text>
					);
				}
				return (
					<Text key={i} wrap="truncate" {...TONE[row.tone]}>
						{row.text}
					</Text>
				);
			})}
		</Box>
	);
}
