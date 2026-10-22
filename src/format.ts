export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '0ms';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}
