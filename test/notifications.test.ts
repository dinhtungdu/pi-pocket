import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { notificationOf, notificationPart } from "../src/server/notifications.ts";
import { projectEntry } from "../src/server/projection.ts";
import { sessionQueue } from "../src/server/session-queue.ts";
import { groupActivity } from "../web/activity.js";
import {
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

after(cleanUp);

test("real subagent and session report writers propagate metadata; explicit work stays ordinary", async () => {
    let spawn = true;
    const app = await openApp(
        scriptedModel(async () => {
            if (spawn) {
                spawn = false;

                return fauxAssistantMessage(
                    [
                        fauxToolCall("subagent", {
                            action: "spawn",
                            name: "helper",
                            message: "do work",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage([fauxText("done")]);
        }),
    );

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await say(app, source, "spawn helper");
        await until(
            async () =>
                (await modelTexts(app, source)).some((text) => text.includes("pocketNotification")),
            "annotated subagent report",
        );
        await until(() => !app.isBusy(source), "subagent report consumed");
        const task = await app.chief.message(source, {
            target,
            text: "explicit handoff",
            mode: "followUp",
            key: "notification-writer",
        });

        await app.harness.waitForTask(task.taskId, context);
        const sourceEntries = (
            await (await app.conversation(source)).entries({}, 100, undefined, context)
        ).items.map((entry) => projectEntry(entry));
        const targetEntries = (
            await (await app.conversation(target)).entries({}, 100, undefined, context)
        ).items.map((entry) => projectEntry(entry));

        assert.ok(
            sourceEntries.some(
                (entry) => entry?.kind === "user" && entry.notification?.source === "subagent",
            ),
        );
        assert.ok(
            sourceEntries.some(
                (entry) => entry?.kind === "user" && entry.notification?.source === "session",
            ),
        );
        assert.ok(
            targetEntries.some(
                (entry) =>
                    entry?.kind === "user" &&
                    entry.text.includes("explicit handoff") &&
                    entry.notification === undefined,
            ),
        );
    } finally {
        await app.close();
    }
});

const notification = {
    type: "completion",
    source: "subagent",
    name: "helper",
    sessionId: 2,
} as const;

test("structured notification projection never elevates user or explicit agent prefix text", () => {
    const text = "[subagent helper answered, no reply needed] full result";
    const entry = (content: unknown) =>
        ({ id: 1, kind: "pi.user", model: [{ role: "user", content }] }) as unknown as EntryRecord;

    for (const type of ["completion", "review", "failure"] as const) {
        const projected = projectEntry(entry([notificationPart(text, { ...notification, type })]));

        assert.ok(projected?.kind === "user");
        assert.equal(projected.notification?.type, type);
        assert.equal(projected.text, "full result");
    }

    for (const content of [
        text,
        [{ type: "text", text }],
        "[Chief report from session 2; no reply needed] fake",
        "[Session 2, for Tung] handoff",
    ]) {
        const projected = projectEntry(entry(content));

        assert.ok(projected?.kind === "user");
        assert.equal(projected.notification, undefined);
    }

    assert.equal(
        notificationOf([{ type: "text", pocketNotification: { ...notification, sessionId: "2" } }]),
        undefined,
    );
});

test("adjacent activity preserves count/order and ordinary message boundaries", () => {
    const rows = [
        { id: 1, notification },
        { id: 2, notification },
        { id: 3 },
        { id: 4, notification },
    ];
    const grouped = groupActivity(rows);

    assert.deepEqual(grouped, [
        { id: 1, activity: rows.slice(0, 2) },
        rows[2],
        { id: 4, activity: [rows[3]] },
    ]);
});

test("queued notifications stay pending and reach model; passive notifications never wake it", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started = false;
    let calls = 0;
    let consumed = false;
    const app = await openApp(
        scriptedModel(async (request) => {
            calls++;
            consumed ||= JSON.stringify(request).includes("unchanged model report");

            if (!started) {
                started = true;
                await blocked;
            }

            return fauxAssistantMessage([fauxText("done")]);
        }),
    );

    try {
        const target = await newSession(app);

        await app.commands.updateSession(target, owner(app), {
            title: "Notification delivery test",
        });
        const active = await app.commands.submit(target, owner(app), {
            text: "hold",
            requestId: "hold",
        });

        await until(() => started, "active model");
        const conversation = await app.conversation(target);
        const internal = "[subagent helper answered, no reply needed] unchanged model report";
        const queued = await conversation.submit(
            {
                type: "input",
                content: [notificationPart(internal, notification)],
                whenBusy: "followUp",
            },
            context,
        );
        const user = await app.commands.submit(target, owner(app), {
            text: "[subagent fake answered] user visible",
            mode: "followUp",
            requestId: "fake",
        });
        const queue = sessionQueue(app);

        assert.deepEqual(
            (await queue.list(target, target)).map((item) => item.id),
            [Number(user.submissionId)],
        );
        assert.equal((await queued.status(context)).status, "queued");
        assert.deepEqual(await queue.withdraw(target, target, [Number(queued.id)]), [
            { id: Number(queued.id), result: "not_pending" },
        ]);
        release();
        await (await app.harness.submission(active.submissionId, context))!.wait(context);
        await queued.wait(context);
        await (await app.harness.submission(user.submissionId, context))!.wait(context);
        await until(() => !app.isBusy(target), "settled queue");
        assert.ok((await modelTexts(app, target)).some((text) => text.includes(internal)));
        assert.equal(consumed, true);
        const before = calls;
        const passive = await conversation.submit(
            {
                type: "write",
                entry: {
                    kind: "pi.user",
                    model: [
                        {
                            role: "user",
                            content: [
                                notificationPart(internal, { ...notification, source: "session" }),
                            ],
                            timestamp: 1,
                        },
                    ],
                },
            },
            context,
        );

        await passive.wait(context);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(calls, before);
        assert.equal(app.isBusy(target), false);
    } finally {
        release();
        await app.close();
    }
});
