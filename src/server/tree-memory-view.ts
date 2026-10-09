import type { Message } from "@earendil-works/pi-ai";
import type { ContextView } from "@earendil-works/pi-durable";

/** Select from NATIVE ordered messages, retaining native synthesized missing tool results. */
export function currentMessages(view: ContextView, boundary: number): Message[] {
    const selected = new Set<Message>(
        view.entries.flatMap((entry, index) =>
            entry.id >= boundary
                ? view.contributions[index]!.filter((message) => message.role !== "system")
                : [],
        ),
    );
    const calls = new Set(
        [...selected].flatMap((message) =>
            message.role === "assistant"
                ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
                : [],
        ),
    );

    return view.messages.filter(
        (message) =>
            selected.has(message) ||
            (message.role === "toolResult" && calls.has(message.toolCallId)),
    );
}

/** Collapse native positional system patches without treating transcript evidence as instructions. */
export function replaySections(messages: readonly Message[]): Record<string, string> {
    const result: Record<string, string> = {};

    for (const message of messages) {
        if (message.role !== "system") {
            continue;
        }

        for (const [key, text] of Object.entries(message.sections ?? {})) {
            if (text === null) {
                delete result[key];
            } else {
                result[key] = text;
            }
        }
    }

    return result;
}
