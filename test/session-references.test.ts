import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { SessionMessagesDoc } from "../src/server/docs.ts";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    say,
} from "./helpers.ts";

after(cleanUp);

test("plain names and removed aliases never inject home context or dispatch work", async () => {
    const received: string[] = [];
    const model = scriptedModel((request) => {
        received.push(lastText(request as never).text);

        return fauxAssistantMessage([fauxText("ready")]);
    });
    const data = join(root, "home-reference-context");
    let app = await openApp(model, data);

    try {
        const user = owner(app);
        const source = await newSession(app);

        await say(app, source, "ask Alfred");
        assert.equal(received.at(-1), "ask Alfred");
        assert.equal(app.sessions().length, 1, "mention does not create home");

        const home = await newSession(app);
        const collision = await newSession(app);

        await app.commands.updateSession(collision, user, { title: "Alfred", archived: true });
        await app.commands.updateSession(home, user, { title: "Alfred" });

        for (const text of ["tell Alfred", "@chief"]) {
            await say(app, source, text);
            assert.equal(received.at(-1), text);
        }

        const stable = `[@Alfred](/s/${collision})`;

        await say(app, source, stable);
        assert.equal(received.at(-1), stable, "stable reference is not rebound to home");
        await app.commands.updateSession(home, user, { title: "Morgan" });
        await app.close();
        app = await openApp(model, data);
        await say(app, source, "tell Morgan");
        assert.equal(received.at(-1), "tell Morgan");
        await say(app, source, "tell Alfred");
        assert.equal(
            received.at(-1),
            "tell Alfred",
            "old alias does not fall back to title collision",
        );
        const oldStable = `[@Alfred](/s/${home})`;

        await say(app, source, oldStable);
        assert.equal(received.at(-1), oldStable, "stable old label keeps its explicit home id");
        assert.equal(await app.harness.snapshot(SessionMessagesDoc, source, context), undefined);

        for (const id of [home, collision]) {
            const page = await (await app.conversation(id)).entries({}, 100, undefined, context);

            assert.equal(page.items.length, 0, "references never start target conversations");
        }
    } finally {
        await app.close();
    }
});
