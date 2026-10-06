// Conversation references carry the stable session id; labels are for people, never routing instructions.
export const CONVERSATION_REFERENCE = /\[(@(?:\\.|[^\\\]\n])+)\]\(\/s\/([1-9]\d*)\)/g;

export function conversationMention(session) {
    const name = (session.name ?? session.title ?? `Session ${session.id}`)
        .replace(/\s+/g, " ")
        .replace(/[\\\[\]]/g, "\\$&");

    return `[@${name}](/s/${session.id})`;
}

export function conversationReferences(text) {
    return [...text.matchAll(CONVERSATION_REFERENCE)]
        .filter((match) => Number.isSafeInteger(Number(match[2])))
        .map((match) => ({
            id: Number(match[2]),
            label: match[1].replace(/\\(.)/g, "$1"),
            start: match.index,
            end: match.index + match[0].length,
        }));
}

export function suggestConversations(sessions, sourceId, query) {
    const search = query.toLowerCase().trim();

    return sessions
        .filter((session) => session.id !== sourceId)
        .map((session) => {
            const name = session.title || `Session ${session.id}`;
            const lower = name.toLowerCase();
            const parent = `#${session.id}${session.archived ? " · archived" : ""}${session.cwd ? ` · ${session.cwd}` : ""}`;
            const rank =
                lower === search
                    ? 3
                    : lower.startsWith(search)
                      ? 2
                      : lower.includes(search)
                        ? 1
                        : 0;

            return { kind: "conversation", id: session.id, name, parent, rank };
        })
        .filter((item) => item.rank > 0 || item.parent.toLowerCase().includes(search))
        .sort((a, b) => b.rank - a.rank || b.id - a.id)
        .slice(0, 20);
}
