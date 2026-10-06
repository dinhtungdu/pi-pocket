import { conversationReferences } from "../../web/conversation-mentions.js";

/** Stable Markdown references already bind their own id; never reinterpret their labels. */
export function mentionsHome(text: string, name: string): boolean {
    const prose = conversationReferences(text).reduceRight(
        (rest, reference) => rest.slice(0, reference.start) + " " + rest.slice(reference.end),
        text,
    );
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundary = "[\\p{L}\\p{N}\\p{M}_]";

    return new RegExp(`(?<!${boundary})(?:@chief|${escaped})(?!${boundary})`, "iu").test(prose);
}
