// Chief display names reuse session titles without changing coordinator identity.
import { cleanUp, owner, root, say, scriptedModel } from "./helpers.ts";
import { openApp } from "./owner-sessions.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import {
    conversationMention,
    conversationReferences,
    suggestConversations,
} from "../web/conversation-mentions.js";

after(cleanUp);

test("Chief rename persists through HTTP and restart; guidance follows name, not authority", async () => {
    const prompts: string[] = [];
    const model = scriptedModel((request) => {
        prompts.push(JSON.stringify(request));

        return fauxAssistantMessage([fauxText("ready")]);
    });
    const data = join(root, "chief-name");
    let app = await openApp(model, data);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const { id } = await app.chief.open(owner(app));

    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${id}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${app.config.ownerToken}`,
                "x-pocket": "1",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ title: " Alfred " }),
        });

        assert.equal(response.status, 200);
        assert.equal(app.sessionMeta(id)?.title, "Alfred");
        assert.equal(await app.chief.nameFor(id), "Alfred");
        assert.equal((await app.chief.open(owner(app))).id, id);
        await say(app, id, "@chief context only");
        assert.match(prompts.at(-1)!, /Your display name is .*Alfred/);
        assert.match(prompts.at(-1)!, /Your role grants no extra permissions/);
        await assert.rejects(
            app.commands.updateSession(id, owner(app), { archived: true }),
            /cannot be archived/,
        );
        await assert.rejects(app.commands.reset(id, owner(app), undefined), /cannot be reset/);
        await assert.rejects(app.commands.fork(id, owner(app), {}), /cannot be forked/);
        await app.close();
        app = await openApp(model, data);
        assert.equal((await app.chief.open(owner(app))).id, id);
        assert.equal(app.sessionMeta(id)?.title, "Alfred");
        assert.equal(app.sessionMeta(id)?.chiefFor, owner(app).id);
        await say(app, id, "name after restart");
        assert.match(prompts.at(-1)!, /Your display name is .*Alfred/);
        await app.commands.updateSession(id, owner(app), { title: " " });
        assert.equal(app.sessionMeta(id)?.title, "Chief");
        assert.equal(await app.chief.nameFor(id), "Chief");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});

test("@chief alias suggests renamed home, never archived Chief implementation; references keep id", () => {
    const home = { id: 1697, title: "Alfred", chiefFor: "owner" };
    const sessions = [home, { id: 1071, title: "Chief implementation", archived: true }];
    const suggestion = suggestConversations(sessions, 2, "chief").find(
        (item) => item.id === home.id,
    );

    assert.equal(suggestion?.name, "Alfred");
    assert.equal(suggestConversations(sessions, 2, "alfred")[0]?.id, home.id);
    assert.equal(conversationMention(home), "[@Alfred](/s/1697)");
    assert.equal(conversationReferences("[@Chief](/s/1697)")[0]?.id, home.id);
    assert.deepEqual(conversationReferences("@chief"), []);
});
