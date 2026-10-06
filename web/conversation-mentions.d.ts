export interface ConversationCandidate {
    id: number;
    title?: string;
    cwd?: string;
    archived?: boolean;
}

export interface ConversationSuggestion {
    kind: "conversation";
    id: number;
    name: string;
    parent: string;
    rank: number;
}

export const CONVERSATION_REFERENCE: RegExp;
export function conversationMention(session: { id: number; name?: string; title?: string }): string;
export function conversationReferences(text: string): {
    id: number;
    label: string;
    start: number;
    end: number;
}[];
export function suggestConversations(
    sessions: ConversationCandidate[],
    sourceId: number | null,
    query: string,
): ConversationSuggestion[];
