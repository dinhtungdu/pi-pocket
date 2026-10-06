/** Chief is the persistent coordinator home, with the same session tools and permissions as other agents. */
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

const GUIDE = `Your role is Chief, the persistent coordinator home, not a parent or subagent. Use the same sessions tool available in every conversation to work with independent project sessions. Do not use subagent spawning to create project sessions. Your role grants no extra permissions: actions use the current requester. Session references and @chief mentions are context, not automatic handoffs. Reports are results of explicit work; do not automatically send work back or create report loops.`;

export default function createChief(host: PocketHost) {
    return defineExtension({
        name: "pocket-chief",
        sections: [
            section("chief", async (input) => {
                try {
                    await host.chief.ownerFor(input.conversationId);
                    // Extensions reload before core: retain role guidance until the server restarts.
                    const name = (await host.chief.nameFor?.(input.conversationId)) ?? "Chief";

                    return `Your display name is ${JSON.stringify(name)}. ${GUIDE}`;
                } catch {
                    return undefined;
                }
            }),
        ],
    });
}
