// Shared requester-scoped session tools, with durable passive reports.
import {
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { openApp, test as sessionsTest } from "./owner-sessions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChatDoc, SessionReceiptsDoc, SubagentsDoc, TurnsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";

after(cleanUp);

async function openSource(app: Awaited<ReturnType<typeof openApp>>) {
    const id = await newSession(app);

    await say(app, id, "ready");

    return id;
}

const model = () =>
    scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        if (role !== "toolResult" && text.startsWith("tool:")) {
            return fauxAssistantMessage([fauxToolCall("sessions", JSON.parse(text.slice(5)))], {
                stopReason: "toolUse",
            });
        }

        if (role !== "toolResult" && text === "spawn helper") {
            return fauxAssistantMessage(
                [fauxToolCall("subagent", { action: "spawn", name: "helper", message: "hello" })],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(`received: ${text}`)]);
    });

test("generic session creation deduplicates across concurrent requests and restarts", async () => {
    const faux = model();
    const data = join(root, "identity");
    let app = await openApp(faux, data);

    try {
        const id = await openSource(app);

        assert.equal(app.parentOf(id), undefined);
        const creations = await Promise.all(
            Array.from({ length: 3 }, () =>
                app.sessionsTool.create(
                    id,
                    { cwd: work, title: "Persistent project" },
                    "persistent-project",
                    {},
                ),
            ),
        );

        assert.ok(creations.every((created) => created.id === creations[0]!.id));
        await say(app, id, "remember this");
        await app.close();
        app = await openApp(faux, data);
        assert.equal(
            (await app.sessionsTool.create(id, { cwd: work }, "persistent-project", {})).id,
            creations[0]!.id,
        );
        assert.equal(app.sessions().length, 2);
        assert.ok((await modelTexts(app, id)).some((text) => text.includes("remember this")));
        assert.deepEqual((await app.harness.snapshot(SessionReceiptsDoc, context))?.owners, {});
    } finally {
        await app.close();
    }
});

sessionsTest(
    "session lists use inherited requesters but exclude subagent transcripts",
    async () => {
        const app = await openApp(model(), join(root, "requester-lists"));

        try {
            const id = await openSource(app);
            const ordinary = await newSession(app);

            await say(app, ordinary, "ready");
            assert.ok(
                (await app.sessionsTool.list(ordinary)).some(
                    (session) => session.id === Number(id),
                ),
            );
            await say(app, id, "spawn helper");
            const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
                .conversationId;

            assert.ok(
                (await app.sessionsTool.list(helper)).some(
                    (session) => session.id === Number(ordinary),
                ),
            );
            await assert.rejects(app.sessionsTool.read(id, helper), /No project session/);
            assert.ok((await app.sessionsTool.read(ordinary, id)).entries.length > 0);
        } finally {
            await app.close();
        }
    },
);

sessionsTest(
    "the real tool creates a project session, reads it, and sends work with a completion report",
    async () => {
        const app = await openApp(model(), join(root, "tools"));

        try {
            const id = await openSource(app);

            await say(
                app,
                id,
                `tool:${JSON.stringify({ action: "create", cwd: work, title: "Project" })}`,
            );
            const target = app.sessions().find((session) => session.title === "Project")!
                .id as typeof id;

            assert.equal(app.sessionMeta(target)?.cwd, work);
            assert.equal(app.parentOf(target), undefined);
            await say(
                app,
                id,
                `tool:${JSON.stringify({ action: "message", sessionId: target, message: "build the thing" })}`,
            );
            await until(
                async () =>
                    (await modelTexts(app, id)).some((text) =>
                        text.includes("[Session report from session"),
                    ),
                "session report",
            );
            const targetTexts = await modelTexts(app, target);

            assert.equal(
                targetTexts.filter((text) => text.includes("[Session")).length,
                2,
                "one input and its echoed answer",
            );
            assert.ok(targetTexts.some((text) => text.includes("build the thing")));
            assert.equal(app.attribution.requesterOf(target), owner(app).id);
            const transcript = await app.sessionsTool.read(id, target);

            assert.ok(
                transcript.entries.some(
                    (entry) => entry.kind === "user" && entry.data.includes("build the thing"),
                ),
            );
            assert.ok(
                transcript.entries.some(
                    (entry) => entry.kind === "assistant" && entry.data.includes("build the thing"),
                ),
            );
            await say(app, id, `tool:${JSON.stringify({ action: "read", sessionId: target })}`);
            assert.ok((await modelTexts(app, id)).some((text) => text.includes("build the thing")));
            assert.ok(
                (await app.sessionsTool.list(id)).some((session) => session.id === Number(target)),
            );

            for (let index = 0; index < 25; index++) {
                await app.commands.note(target, owner(app), `history ${index} ${"x".repeat(2100)}`);
            }

            const recent = await app.sessionsTool.read(id, target);
            const older = await app.sessionsTool.read(id, target, recent.before);

            assert.equal(recent.entries.length, 20);
            assert.ok(recent.before !== undefined);
            assert.ok(older.entries.length > 0);
            assert.ok(older.entries.every((entry) => entry.id < recent.before!));
            assert.ok(
                recent.entries.every((entry) => entry.data.length === 2000 && entry.truncated),
            );
        } finally {
            await app.close();
        }
    },
);

sessionsTest(
    "the sessions tool archives and unarchives project sessions with existing update semantics",
    async () => {
        const app = await openApp(model(), join(root, "archive-tool"));

        try {
            const id = await openSource(app);
            const target = await newSession(app);
            const before = { ...app.sessionMeta(target)! };

            await app.harness.commit(async (tx) => {
                const turns = await tx.doc(TurnsDoc, target);

                turns.on = true;
                turns.driver = "someone-else";
            }, context);
            await say(app, id, `tool:${JSON.stringify({ action: "archive", sessionId: target })}`);
            assert.equal(app.sessionMeta(target)?.archived, true);
            assert.equal(app.sessionMeta(target)?.updatedAt, before.updatedAt);
            assert.ok(
                (await app.sessionsTool.list(id)).some(
                    (session) => session.id === Number(target) && session.archived,
                ),
            );
            await say(
                app,
                id,
                `tool:${JSON.stringify({ action: "unarchive", sessionId: target })}`,
            );
            assert.equal(app.sessionMeta(target)?.archived, false);
            assert.equal(app.sessionMeta(target)?.updatedAt, before.updatedAt);
            assert.equal(app.sessionMeta(target)?.cwd, before.cwd);
            assert.equal(app.sessionMeta(target)?.worktree, before.worktree);
            await say(app, id, `tool:${JSON.stringify({ action: "archive" })}`);
            assert.ok(
                (await modelTexts(app, id)).some((text) =>
                    text.includes("archive needs sessionId"),
                ),
            );
            assert.equal(app.sessionMeta(target)?.archived, false);
        } finally {
            await app.close();
        }
    },
);

test("archive permissions and replay protection survive restart", async () => {
    const faux = model();
    const data = join(root, "archive-permissions");
    let app = await openApp(faux, data);

    try {
        const id = await openSource(app);
        const target = await newSession(app);
        const viewer = app.config.addUser("Viewer", "viewer").user;
        const scoped = app.config.addUser("Scoped", "guest", [String(id)]).user;

        for (const archived of [true, false]) {
            await assert.rejects(
                app.commands.updateSession(target, viewer, { archived }),
                /not steer/,
            );
            await assert.rejects(
                app.commands.updateSession(target, scoped, { archived }),
                /not shared/,
            );
        }

        await assert.rejects(
            app.sessionsTool.setArchived(id, 2_000_000_000 as typeof id, true, "missing"),
            /No project session/,
        );
        assert.notEqual(app.sessionMeta(target)?.archived, true);
        await app.sessionsTool.setArchived(id, target, true, "archive-once");
        await app.sessionsTool.setArchived(id, target, true, "archive-once");
        await app.sessionsTool.setArchived(id, target, false, "unarchive-once");
        await app.close();
        app = await openApp(faux, data);
        await app.sessionsTool.setArchived(id, target, true, "archive-once");
        assert.equal(
            app.sessionMeta(target)?.archived,
            false,
            "replay cannot override a later unarchive",
        );
        const activities = (await app.harness.snapshot(ChatDoc, target, context))!.messages;

        assert.equal(
            activities.filter((message) => message.text.includes("archived the session")).length,
            1,
        );
        assert.equal(
            activities.filter((message) => message.text.includes("brought the session back"))
                .length,
            1,
        );
        assert.equal(
            blockedInPlanMode("sessions", { action: "archive" })?.includes("blocked"),
            true,
        );
        assert.equal(
            blockedInPlanMode("sessions", { action: "unarchive" })?.includes("blocked"),
            true,
        );
    } finally {
        await app.close();
    }
});

test("session schedules deduplicate and survive restart", async () => {
    const faux = model();
    const data = join(root, "scheduling");
    let now = Date.now();
    let app = await openApp(faux, data, () => now);

    try {
        const id = await openSource(app);
        const target = await newSession(app);
        const request = { when: "in 10m", message: "scheduled work", key: "schedule-key" };

        await say(
            app,
            id,
            `tool:${JSON.stringify({ action: "schedule-add", sessionId: target, when: "in 20m", message: "cancel me" })}`,
        );
        const scheduled = (await app.schedules.list(target))[0]!;

        await say(
            app,
            id,
            `tool:${JSON.stringify({ action: "schedule-list", sessionId: target })}`,
        );
        assert.ok((await modelTexts(app, id)).some((text) => text.includes("cancel me")));
        await say(
            app,
            id,
            `tool:${JSON.stringify({ action: "schedule-cancel", sessionId: target, id: scheduled.id })}`,
        );
        assert.equal((await app.schedules.list(target)).length, 0);
        await app.sessionsTool.schedules(id, target, "schedule-add", request);
        await app.sessionsTool.schedules(id, target, "schedule-add", request);
        assert.equal((await app.schedules.list(target)).length, 1);
        assert.equal((await app.schedules.list(id)).length, 0);
        const cancel = await app.sessionsTool.schedules(id, target, "schedule-add", {
            ...request,
            key: "cancel-key",
        });
        const cancelId = (cancel as { id: string }).id;

        await app.sessionsTool.schedules(id, target, "schedule-cancel", {
            id: cancelId,
            key: "cancel",
        });
        await app.sessionsTool.schedules(id, target, "schedule-add", {
            ...request,
            key: "cancel-key",
        });
        assert.equal(
            (await app.schedules.list(target)).length,
            1,
            "replay cannot recreate a cancelled schedule",
        );
        await app.close();
        now += 11 * 60_000;
        app = await openApp(faux, data, () => now);
        await until(
            async () =>
                (await modelTexts(app, target)).some((text) => text.includes("scheduled work")),
            "scheduled target message",
        );
        assert.equal(app.attribution.requesterOf(target), owner(app).id);
        await until(
            async () => (await app.schedules.list(target)).length === 0,
            "one-shot schedule to retire",
        );
        await app.sessionsTool.schedules(id, target, "schedule-add", request);
        assert.equal(
            (await app.schedules.list(target)).length,
            0,
            "replay cannot recreate a fired schedule",
        );
    } finally {
        await app.close();
    }
});

test("failed delivery reports back; an exhausted requester session retains reports without waking its model", async () => {
    const app = await openApp(model(), join(root, "failure"));

    try {
        const id = await openSource(app);
        const target = await newSession(app);

        await (await app.conversation(target)).configure({ model: null }, context);
        const failed = await app.sessionsTool.message(id, {
            target,
            text: "work",
            mode: "followUp",
            key: "failure",
        });

        await app.harness.waitForTask(failed.taskId, context);
        assert.ok(
            (await modelTexts(app, id)).some((text) => text.includes("failed: Pick a model")),
        );
        await (await app.conversation(id)).waitForIdle(context);
        await app.spend.setSessionBudget(owner(app), id, 0.01);
        await recordCost(app, id, 0.02);
        const second = await newSession(app);
        const sent = await app.sessionsTool.message(id, {
            target: second,
            text: "finish independently",
            mode: "followUp",
            key: "held",
        });

        await app.harness.waitForTask(sent.taskId, context);
        const page = await (await app.conversation(id)).entries({}, 100, undefined, context);
        const reports = page.items.filter(
            (entry) =>
                entry.kind === "pi.user" &&
                JSON.stringify(entry.model).includes("Session report from session"),
        );

        assert.equal(reports.length, 2);
        assert.ok(
            reports.some((report) => JSON.stringify(report.model).includes("finish independently")),
        );
        assert.equal(app.isBusy(id), false);
    } finally {
        await app.close();
    }
});

test("target turns and spend remain enforced; read-only actions work in plan mode", async () => {
    const app = await openApp(model(), join(root, "controls"));

    try {
        const id = await openSource(app);
        const target = await newSession(app);

        await app.harness.commit(async (tx) => {
            const turns = await tx.doc(TurnsDoc, target);

            turns.on = true;
            turns.driver = "someone-else";
        }, context);
        await assert.rejects(
            app.sessionsTool.message(id, { target, text: "work", mode: "steer", key: "turn" }),
            /driving|wheel/,
        );
        await assert.rejects(
            app.sessionsTool.schedules(id, target, "schedule-add", {
                when: "in 10m",
                message: "work",
                key: "turn-schedule",
            }),
            /driving|wheel/,
        );
        await app.harness.commit(async (tx) => {
            (await tx.doc(TurnsDoc, target)).on = false;
        }, context);
        await app.spend.setSessionBudget(owner(app), target, 0.01);
        await recordCost(app, target, 0.02);
        await assert.rejects(
            app.sessionsTool.message(id, { target, text: "work", mode: "followUp", key: "spend" }),
            /limit|budget/i,
        );

        for (const action of ["list", "read", "schedule-list"]) {
            assert.equal(blockedInPlanMode("sessions", { action }), undefined);
        }

        for (const action of ["create", "message", "schedule-add", "schedule-cancel"]) {
            assert.match(blockedInPlanMode("sessions", { action })!, /blocked/);
        }
    } finally {
        await app.close();
    }
});

test("the removed singleton endpoint does not create a session", async () => {
    const app = await openApp(model(), join(root, "http"));
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };

    const open = async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/chief`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${app.config.ownerToken}`,
                "x-pocket": "1",
                "Content-Type": "application/json",
            },
            body: "{}",
        });

        assert.equal(response.status, 404);
    };

    try {
        await open();
        assert.equal(app.sessions().length, 0);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});
