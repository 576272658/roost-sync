/** Runs `fn` over `items` with at most `limit` in flight. Rejects with the first error after all started tasks settle. */
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	let firstError: unknown = null;
	const worker = async () => {
		while (next < items.length && firstError === null) {
			const item = items[next++];
			try {
				await fn(item);
			} catch (e) {
				if (firstError === null) firstError = e;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	if (firstError !== null) throw firstError;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
