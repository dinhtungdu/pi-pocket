export function groupActivity<T extends { id: number; notification?: unknown }>(
    rows: T[],
): (T | { id: number; activity: T[] })[];
