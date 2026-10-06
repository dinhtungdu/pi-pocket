import assert from "node:assert/strict";
import { test } from "node:test";
import {
    conversationMention,
    conversationReferences,
    suggestConversations,
} from "../web/conversation-mentions.js";

test("conversation picker searches title, stable id, and folder including archived sessions", () => {
    const sessions = [
        { id: 1, title: "Current", cwd: "/work/current" },
        { id: 2, title: "Session", cwd: "/work/tools" },
        { id: 3, title: "Session implementation", cwd: "/work/pocket" },
        { id: 4, title: "Old release", cwd: "/work/archive", archived: true },
    ];

    assert.deepEqual(
        suggestConversations(sessions, 1, "session").map((item) => item.id),
        [2, 3],
    );
    assert.equal(suggestConversations(sessions, 1, "4")[0]?.id, 4);
    assert.equal(suggestConversations(sessions, 1, "tools")[0]?.id, 2);
    assert.equal(suggestConversations(sessions, 1, "archive")[0]?.id, 4);
    assert.ok(!suggestConversations(sessions, 1, "").some((item) => item.id === 1));
    assert.deepEqual(suggestConversations(sessions, 1, "missing"), []);
});

test("legacy home markers do not supply an alias or override title matches", () => {
    const home = { id: 1697, title: "Alfred", chiefFor: "owner" };
    const sessions = [
        { id: 1071, title: "Chief", archived: true },
        { id: 9000, title: "Chief implementation", archived: true },
        { id: 9001, title: "Chief" },
        home,
    ];

    const matches = suggestConversations(sessions, 5487, "chief");

    assert.equal(matches[0]?.id, 9001, "active title match ranks above archived matches");
    assert.ok(!matches.some((item) => item.id === home.id), "stored marker supplies no alias");
    assert.equal(suggestConversations(sessions, 5487, "alfred")[0]?.id, home.id);
    assert.equal(suggestConversations(sessions, 5487, "  CHIEF ")[0]?.id, 9001);
    assert.equal(suggestConversations(sessions, 5487, "9000")[0]?.id, 9000);
    assert.ok(!suggestConversations(sessions, home.id, "").some((item) => item.id === home.id));
});

test("selected references preserve conversation identity through rename and escape labels", () => {
    const original = conversationMention({ id: 7, title: "Project" });
    const renamed = conversationMention({ id: 7, title: "Project [work] \\ notes" });

    assert.equal(original, "[@Project](/s/7)");
    assert.equal(conversationReferences(original)[0]?.id, 7);
    assert.equal(conversationReferences(renamed)[0]?.id, 7);
    assert.equal(conversationReferences(renamed)[0]?.label, "@Project [work] \\ notes");
    assert.deepEqual(conversationReferences("literal @chief and @file.md"), []);
    assert.deepEqual(conversationReferences("[@Chief](https://other/s/7) [@Bad](/s/0)"), []);
    assert.equal(conversationReferences(`before ${original} after`)[0]?.start, 7);
    assert.equal(conversationReferences(`before ${original} after`)[0]?.end, 7 + original.length);
});
