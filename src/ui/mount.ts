import React from 'react';
import type {MountControl, UiElement} from '../../../../src/api.js';
import type {RunStore} from '../store.js';
import {colorEnabled} from './kit.js';
import {TestView} from './TestView.js';

export const color = (): boolean => colorEnabled();

export function buildTestView(store: RunStore, abort: () => void, control: MountControl): UiElement {
	return React.createElement(TestView, {store, abort, ...(control.host ? {host: control.host} : {})});
}
