import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { createServer } from "node:http";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { mentionsHome } from "../src/server/session-references.ts";
import { ChiefMessagesDoc } from "../src/server/docs.ts";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    type App,
} from "./helpers.ts";

after(cleanUp);

async function say(app: App, source: ConversationId, text: string) {
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };

    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/c/${source}/submit`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${app.config.ownerToken}`,
                "x-pocket": "1",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text, requestId: crypto.randomUUID() }),
        });

        assert.equal(response.status, 200, await response.clone().text());
        const sent = (await response.json()) as { submissionId: SubmissionId };

        await (await app.harness.submission(sent.submissionId, context))!.wait(context);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test("home names match whole names in prose, without reinterpreting stable references", () => {
    for (const text of ["ask Alfred", "Alfred can check", "tell Alfred", "(ALFRED)", "@chief"]) {
        assert.equal(mentionsHome(text, "Alfred"), true, text);
    }

    for (const text of [
        "Alfredo",
        "preAlfred",
        "Alfred_thing",
        "éAlfred",
        "Alfred中",
        "@chiefly",
    ]) {
        assert.equal(mentionsHome(text, "Alfred"), false, text);
    }

    // The existing reference parser has no code/quote exclusions; do not introduce new ones here.
    for (const text of ["`Alfred`", "```\nAlfred\n```", "> Alfred", '"Alfred"']) {
        assert.equal(mentionsHome(text, "Alfred"), true, text);
    }

    assert.equal(mentionsHome("ask Coordinator [work]", "Coordinator [work]"), true);
    assert.equal(mentionsHome("ask Coordinator xworkx", "Coordinator [work]"), false);
    assert.equal(mentionsHome("[@Alfred](/s/99) [@chief](/s/100)", "Alfred"), false);
    assert.equal(mentionsHome("[@Alfred](/s/99) then tell Alfred", "Alfred"), true);
});

test("submitted context uses registered home and current persisted name; rename drops old alias without sending", async () => {
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

        const home = (await app.chief.open(user)).id;
        const collision = await newSession(app);

        await app.commands.updateSession(collision, user, { title: "Alfred", archived: true });
        await app.commands.updateSession(home, user, { title: "Alfred" });

        for (const text of ["ask Alfred", "Alfred can check", "tell Alfred", "@chief"]) {
            await say(app, source, text);
            assert.ok(received.at(-1)?.endsWith(text));
            assert.ok(
                received.at(-1)?.includes(`coordinator home /s/${home} (sessionId: ${home})`),
            );
            assert.ok(!received.at(-1)?.includes(`/s/${collision}`));
        }

        await say(app, source, "Alfredo can check");
        assert.equal(received.at(-1), "Alfredo can check");
        const stable = `[@Alfred](/s/${collision})`;

        await say(app, source, stable);
        assert.equal(received.at(-1), stable, "stable reference is not rebound to home");
        await app.commands.updateSession(home, user, { title: "Morgan" });
        await app.close();
        app = await openApp(model, data);
        await say(app, source, "tell Morgan");
        assert.ok(received.at(-1)?.includes(`coordinator home /s/${home}`));
        assert.ok(received.at(-1)?.includes('"Morgan"'));
        await say(app, source, "tell Alfred");
        assert.equal(
            received.at(-1),
            "tell Alfred",
            "old alias does not fall back to title collision",
        );
        const oldStable = `[@Alfred](/s/${home})`;

        await say(app, source, oldStable);
        assert.equal(received.at(-1), oldStable, "stable old label keeps its explicit home id");
        await say(app, source, "@chief");
        assert.ok(received.at(-1)?.includes(`coordinator home /s/${home}`));
        assert.ok(received.at(-1)?.includes('"Morgan"'));
        assert.equal(await app.harness.snapshot(ChiefMessagesDoc, source, context), undefined);

        for (const id of [home, collision]) {
            const page = await (await app.conversation(id)).entries({}, 100, undefined, context);

            assert.equal(page.items.filter((entry) => entry.kind === "pi.user").length, 0);
            assert.equal(page.items.filter((entry) => entry.kind === "pi.assistant").length, 0);
        }
    } finally {
        await app.close();
    }
});
