/** Group adjacent notifications only: ordinary messages remain in their original position. */
export function groupActivity(rows) {
    const groups = [];

    for (const row of rows) {
        const last = groups.at(-1);

        if (row.notification) {
            if (last?.activity) {
                last.activity.push(row);
            } else {
                groups.push({ id: row.id, activity: [row] });
            }
        } else {
            groups.push(row);
        }
    }

    return groups;
}
