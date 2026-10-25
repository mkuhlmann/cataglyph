// Bounded-concurrency worker loop.
//
// Every task is wrapped so one thrown error takes down one file instead of the batch.
// jxl-batch used to lack this: a spawn that threw (a missing cjxl, for instance) rejected
// a promise nobody was catching, which aborted the whole run - and, for tasks that weren't
// the one Promise.race happened to be awaiting, surfaced as an unhandled rejection.

export async function runConcurrent<T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>,
    onError: (item: T, error: unknown) => void,
): Promise<void> {
    const active = new Set<Promise<void>>();
    const slots = Math.max(1, limit);

    for (const item of items) {
        const task: Promise<void> = worker(item)
            .catch(error => {
                try {
                    onError(item, error);
                } catch {
                    // The error reporter itself failing must not abort the batch.
                }
            })
            .finally(() => { active.delete(task); });
        active.add(task);

        if (active.size >= slots) {
            await Promise.race(active);
        }
    }

    await Promise.all(active);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
