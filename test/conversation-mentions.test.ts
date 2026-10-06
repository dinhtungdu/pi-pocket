import assert from "node:assert/strict";
import { test } from "node:test";
import {
    conversationMention,
    conversationReferences,
    suggestConversations,
} from "../web/conversation-mentions.js";

test("conversation picker searches title, stable id, and folder including Chief and archived sessions", () => {
    const sessions = [
        { id: 1, title: "Current", cwd: "/work/current" },
        { id: 2, title: "Chief", cwd: "/work/alfred", chiefFor: "owner" },
        { id: 3, title: "Chief implementation", cwd: "/work/pocket" },
        { id: 4, title: "Old release", cwd: "/work/archive", archived: true },
    ];

    assert.deepEqual(
        suggestConversations(sessions, 1, "chief").map((item) => item.id),
        [2, 3],
    );
    assert.equal(suggestConversations(sessions, 1, "4")[0]?.id, 4);
    assert.equal(suggestConversations(sessions, 1, "alfred")[0]?.id, 2);
    assert.equal(suggestConversations(sessions, 1, "archive")[0]?.id, 4);
    assert.ok(!suggestConversations(sessions, 1, "").some((item) => item.id === 1));
    assert.deepEqual(suggestConversations(sessions, 1, "missing"), []);
});

test("@chief prefers the actual renamed home over archived and newer title collisions", () => {
    const home = { id: 1697, title: "Alfred", chiefFor: "owner" };
    const sessions = [
        { id: 1071, title: "Chief", archived: true },
        { id: 9000, title: "Chief implementation", archived: true },
        { id: 9001, title: "Chief" },
        home,
    ];

    for (const sourceId of [5487, home.id]) {
        const selected = suggestConversations(sessions, sourceId, "chief")[0];

        assert.equal(selected?.id, home.id);
        assert.equal(conversationMention(selected!), "[@Alfred](/s/1697)");
    }

    assert.equal(suggestConversations(sessions, 5487, "chi")[0]?.id, home.id);
    assert.equal(suggestConversations(sessions, 5487, "  CHIEF ")[0]?.id, home.id);
    assert.equal(suggestConversations(sessions, 5487, "9000")[0]?.id, 9000);
    assert.ok(!suggestConversations(sessions, home.id, "").some((item) => item.id === home.id));
});

test("selected references preserve conversation identity through rename and escape labels", () => {
    const original = conversationMention({ id: 7, title: "Chief" });
    const renamed = conversationMention({ id: 7, title: "Coordinator [work] \\ notes" });

    assert.equal(original, "[@Chief](/s/7)");
    assert.equal(conversationReferences(original)[0]?.id, 7);
    assert.equal(conversationReferences(renamed)[0]?.id, 7);
    assert.equal(conversationReferences(renamed)[0]?.label, "@Coordinator [work] \\ notes");
    assert.deepEqual(conversationReferences("literal @chief and @file.md"), []);
    assert.deepEqual(conversationReferences("[@Chief](https://other/s/7) [@Bad](/s/0)"), []);
    assert.equal(conversationReferences(`before ${original} after`)[0]?.start, 7);
    assert.equal(conversationReferences(`before ${original} after`)[0]?.end, 7 + original.length);
});
