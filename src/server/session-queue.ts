import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { HttpError } from "./errors.ts";

/** Requester-scoped access to the same pending inputs and withdrawal used by the browser. */
export function sessionQueue(app: PocketApp) {
    const requester = (source: ConversationId, target: ConversationId) => {
        const id = app.attribution.requesterOf(source);
        const user = id === undefined ? undefined : app.config.userById(id);

        if (user === undefined) {
            throw new HttpError(403, "No current requester for this conversation.");
        }

        app.requireSee(user, source);

        if (app.sessionMeta(target) === undefined) {
            throw new HttpError(404, "No project session with that id.");
        }

        app.requireSee(user, target);

        return user;
    };

    return {
        async list(source: ConversationId, target: ConversationId) {
            requester(source, target);
            const inbox = await app.harness.snapshot(InboxDoc, target, BACKGROUND_CONTEXT);

            return (inbox?.items ?? []).flatMap((item) => {
                if (item.mode === "write") {
                    return [];
                }

                const content =
                    typeof item.content === "string"
                        ? item.content
                        : item.content
                              .flatMap((part) => (part.type === "text" ? [part.text] : []))
                              .join(" ");
                const text = content.replace(/\s+/g, " ").trim();

                return [{ id: Number(item.id), mode: item.mode, preview: text.slice(0, 200) }];
            });
        },
        async withdraw(source: ConversationId, target: ConversationId, ids: number[]) {
            const user = requester(source, target);

            app.requireSteer(user);
            const pending = new Set((await this.list(source, target)).map((item) => item.id));
            const results = [];

            for (const id of ids) {
                // Only user inputs from this queue; passive writes and active/settled work stay untouched.
                results.push({
                    id,
                    result: pending.has(id)
                        ? await app.commands.withdraw(target, user, id)
                        : "not_pending",
                });
            }

            return results;
        },
    };
}
