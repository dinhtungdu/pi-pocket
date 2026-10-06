// Stored former home sessions retain their titles and become ordinary sessions.
import { cleanUp, context, newSession, owner, root, say, scriptedModel } from "./helpers.ts";
import { openApp } from "./owner-sessions.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { defineExtension } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { SessionReceiptsDoc, SessionsDoc } from "../src/server/docs.ts";

after(cleanUp);

test("stored home reloads without role instructions and supports ordinary rename/archive/fork/reset", async () => {
    const prompts: string[] = [];
    const model = scriptedModel((request) => {
        prompts.push(JSON.stringify(request));

        return fauxAssistantMessage([fauxText("ready")]);
    });
    const data = join(root, "legacy-home");
    let app = await openApp(model, data);
    const id = await newSession(app);

    // Reproduce persisted pre-removal metadata and the agent extension selection.
    await app.harness.commit(async (tx) => {
        const sessions = await tx.doc(SessionsDoc);
        const receipts = await tx.doc(SessionReceiptsDoc);

        sessions.items[String(id)]!.chiefFor = owner(app).id;
        sessions.items[String(id)]!.title = "Chief";
        receipts.owners[owner(app).id] = id;
    }, context);
    await (
        await app.conversation(id)
    ).configure({ extensions: { add: [defineExtension({ name: "pocket-chief" })] } }, context);
    await app.close();
    app = await openApp(model, data);

    try {
        assert.ok(app.sessions().some((session) => session.id === id));
        assert.equal(app.loader.files().includes("chief.ts"), false);
        await app.commands.updateSession(id, owner(app), { title: " Alfred " });
        assert.equal(app.sessionMeta(id)?.title, "Alfred");
        await say(app, id, "@chief context only");
        assert.doesNotMatch(
            prompts.at(-1)!,
            /Your role is Chief|Your display name is|coordinator home/,
        );
        await app.commands.updateSession(id, owner(app), { archived: true });
        assert.equal(app.sessionMeta(id)?.archived, true);
        await app.commands.updateSession(id, owner(app), { archived: false });
        const page = await (await app.conversation(id)).entries({}, 100, undefined, context);
        const reply = page.items.find((entry) => entry.kind === "pi.assistant")!;
        const fork = await app.commands.fork(id, owner(app), { entryId: reply.id });

        assert.ok(app.sessionMeta(fork.id));
        await app.commands.reset(id, owner(app), undefined);
        await app.close();
        app = await openApp(model, data);
        assert.equal(app.sessionMeta(id)?.title, "Alfred");
        assert.equal(
            app.sessionMeta(id)?.chiefFor,
            owner(app).id,
            "legacy data need not be rewritten",
        );
        await say(app, id, "name after restart");
        assert.doesNotMatch(
            prompts.at(-1)!,
            /Your role is Chief|Your display name is|coordinator home/,
        );
        await app.commands.updateSession(id, owner(app), { title: " " });
        assert.equal(app.sessionMeta(id)?.title, undefined);
    } finally {
        await app.close();
    }
});
