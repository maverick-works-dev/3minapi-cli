/**
 * Minimum Node version check (docs/design/15_cli.md §2). Running user `.ts` workers without a build step needs this floor.
 *
 * ⚠️ bin.ts imports this before any other module. To parse on old Node, it imports nothing but the value-only constants.ts.
 */
import { MIN_NODE_VERSION } from './domain/constants.ts';

type Triple = [number, number, number];

export function parseVersion(version: string): Triple | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function satisfiesMinNode(current: string, min: string = MIN_NODE_VERSION): boolean {
	const a = parseVersion(current);
	const b = parseVersion(min);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return true;
}
