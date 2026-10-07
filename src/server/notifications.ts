import type { TextContent } from "@earendil-works/pi-ai";

/** Only internal report writers create this annotation; user submission APIs rebuild text parts. */
export type Notification = {
    type: "completion" | "review" | "failure";
    source: "subagent" | "session";
    name: string;
    sessionId: number;
};

export function notificationPart(
    text: string,
    notification: Notification,
): TextContent & {
    pocketNotification: Notification;
} {
    return { type: "text", text, pocketNotification: notification };
}

export function notificationOf(content: unknown): Notification | undefined {
    if (!Array.isArray(content)) {
        return undefined;
    }

    const value = content[0]?.pocketNotification;

    if (
        content[0]?.type !== "text" ||
        value === null ||
        typeof value !== "object" ||
        !["completion", "review", "failure"].includes(value.type) ||
        !["subagent", "session"].includes(value.source) ||
        typeof value.name !== "string" ||
        !Number.isSafeInteger(value.sessionId) ||
        value.sessionId < 1
    ) {
        return undefined;
    }

    return value;
}

export function notificationDisplay(model: unknown): {
    notification?: Notification;
    text?: string;
} {
    const content = Array.isArray(model) ? model[0]?.content : undefined;
    const notification = notificationOf(content);

    return notification === undefined
        ? {}
        : {
              notification,
              text: notificationText(
                  content
                      .filter((part: { type: string }) => part.type === "text")
                      .map((part: { text: string }) => part.text)
                      .join("\n"),
              ),
          };
}

/** Internal instructions remain in model content, not in the notification display. */
export function notificationText(text: string): string {
    const failed = /^\[subagent \S+ failed: ([^\]]+)\]$/.exec(text);

    return failed === null
        ? text.replace(
              /^\[(?:subagent [^\]]+|Chief report from session \d+; no reply needed)\]\s?/,
              "",
          )
        : `failed: ${failed[1]}`;
}
