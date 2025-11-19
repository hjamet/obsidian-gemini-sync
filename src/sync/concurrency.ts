
/**
 * Simple p-limit implementation to limit concurrency.
 * @param limit Max number of concurrent executions
 * @returns A function that accepts a generator function and returns a promise
 */
export function pLimit(limit: number) {
    const queue: (() => void)[] = [];
    let activeCount = 0;

    const next = () => {
        activeCount--;
        if (queue.length > 0) {
            const job = queue.shift();
            if (job) job();
        }
    };

    const run = async <T>(fn: () => Promise<T>, resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => {
        activeCount++;
        try {
            const result = await fn();
            resolve(result);
        } catch (err) {
            reject(err);
        } finally {
            next();
        }
    };

    const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
        return new Promise((resolve, reject) => {
            const job = () => run(fn, resolve, reject);
            if (activeCount < limit) {
                job();
            } else {
                queue.push(job);
            }
        });
    };

    return enqueue;
}

