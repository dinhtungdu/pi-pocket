import {
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp as openCoreApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import { openApp, test, sessionsSource } from "./owner-sessions.ts";
import { sessionQueue } from "../src/server/session-queue.ts";
import { TurnsDoc } from "../src/server/docs.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { after, test as coreTest } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

after(cleanUp);

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

// Run the installed module itself; interrupted safe tool calls reuse their task's durable memo.
test("clear replays its captured IDs, never later arrivals", async () => {
    const create = (await import(pathToFileURL(sessionsSource).href)).default;
    let pending = [{ id: 11, mode: "followUp", preview: "first" }];
    let fail = true;
    const withdrawn: number[][] = [];
    const extension = create({
        sessionQueue: {
            list: async () => pending,
            withdraw: async (_source: number, _target: number, ids: number[]) => {
                withdrawn.push([...ids]);

                if (fail) {
                    fail = false;
                    pending = [{ id: 12, mode: "followUp", preview: "later" }];

                    throw new Error("interrupted after withdrawal");
                }

                return [];
            },
        },
    });
    const memos = new Map();
    const api = {
        conversationId: 1,
        taskId: 2,
        callId: "clear",
        memo: async (name: string, candidate: unknown, ctx?: unknown) => {
            if (ctx !== undefined && !memos.has(name)) {
                memos.set(name, candidate);
            }

            return memos.get(name);
        },
    };
    const tool = extension.tools[0];
    const args = { action: "queue-clear", sessionId: 3 };

    await assert.rejects(tool.execute(args, api, context), /interrupted/);
    await tool.execute(args, api, context);
    assert.deepEqual(withdrawn, [[11], [11]]);
    assert.deepEqual(
        pending.map((item) => item.id),
        [12],
    );
    await assert.rejects(
        tool.execute({ action: "queue-withdraw", sessionId: 3 }, api, context),
        /needs ids/,
    );
});

test("installed queue actions preserve active work/history, target IDs, and later arrivals", async () => {
    const blocked = gate();
    let started = false;
    const app = await openApp(
        scriptedModel(async (request) => {
            const { role, text } = lastText(request as never);

            if (text.includes("hold-active")) {
                started = true;
                await blocked.promise;
            }

            if (role !== "toolResult" && text.startsWith("tool:")) {
                return fauxAssistantMessage([fauxToolCall("sessions", JSON.parse(text.slice(5)))], {
                    stopReason: "toolUse",
                });
            }

            return fauxAssistantMessage([fauxText("done")]);
        }),
        join(root, "queue-actions"),
    );

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await say(app, source, "ready");
        await say(app, target, "retained history");
        const active = await app.commands.submit(target, owner(app), {
            text: "hold-active",
            requestId: "active",
        });

        await until(() => started, "blocked model");
        const enqueue = (text: string) =>
            app.commands.submit(target, owner(app), {
                text,
                mode: "followUp",
                requestId: crypto.randomUUID(),
            });
        const a = await enqueue("first\n queued");
        const b = await enqueue("b".repeat(300));
        const queue = sessionQueue(app);
        const list = await queue.list(source, target);

        assert.deepEqual(
            list.map((item) => item.id),
            [Number(a.submissionId), Number(b.submissionId)],
        );
        assert.equal(list[0]!.preview, "first queued");
        assert.equal(list[1]!.preview.length, 200);
        const steer = await app.commands.submit(target, owner(app), {
            text: "steer without clearing",
            mode: "steer",
            requestId: "steer",
        });

        assert.deepEqual(
            (await queue.list(source, target)).map((item) => item.id),
            [Number(a.submissionId), Number(b.submissionId), Number(steer.submissionId)],
        );
        await queue.withdraw(source, target, [Number(steer.submissionId)]);
        const passive = await (
            await app.conversation(target)
        ).submit(
            {
                type: "write",
                entry: { kind: "queue-test.passive", data: "retained report" },
            },
            context,
        );

        assert.equal((await queue.list(source, target)).length, 2);
        assert.deepEqual(await queue.withdraw(source, source, [Number(b.submissionId)]), [
            { id: Number(b.submissionId), result: "not_pending" },
        ]);
        await queue.withdraw(source, target, [Number(passive.id)]);
        assert.equal((await passive.status(context)).status, "queued");
        await say(
            app,
            source,
            `tool:${JSON.stringify({ action: "queue-list", sessionId: target })}`,
        );
        assert.ok((await modelTexts(app, source)).some((text) => text.includes("first queued")));
        await say(
            app,
            source,
            `tool:${JSON.stringify({ action: "queue-withdraw", sessionId: target, ids: [Number(a.submissionId)] })}`,
        );
        assert.deepEqual(
            (await queue.list(source, target)).map((item) => item.id),
            [Number(b.submissionId)],
        );
        await say(
            app,
            source,
            `tool:${JSON.stringify({ action: "queue-clear", sessionId: target })}`,
        );
        assert.deepEqual(await queue.list(source, target), []);
        assert.equal((await passive.status(context)).status, "queued");
        assert.equal(
            (await (await app.harness.submission(active.submissionId, context))!.status(context))
                .status,
            "placed",
        );
        const later = await enqueue("later arrival");

        await queue.withdraw(source, target, [Number(active.submissionId)]);
        assert.equal(
            (await (await app.harness.submission(active.submissionId, context))!.status(context))
                .status,
            "placed",
        );
        assert.deepEqual(
            (await queue.list(source, target)).map((item) => item.id),
            [Number(later.submissionId)],
        );
        blocked.release();
        await (await app.harness.submission(later.submissionId, context))!.wait(context);
        const history = await modelTexts(app, target);

        assert.ok(history.some((text) => text.includes("retained history")));
        assert.ok(history.some((text) => text.includes("hold-active")));
        assert.ok(history.some((text) => text.includes("later arrival")));
        assert.equal(
            (await (await app.harness.submission(a.submissionId, context))!.status(context)).status,
            "unanswered",
        );
        const entries = await (await app.conversation(target)).entries({}, 100, undefined, context);

        assert.ok(entries.items.some((entry) => entry.kind === "queue-test.passive"));
    } finally {
        blocked.release();
        await app.close();
    }
});

coreTest(
    "queue service rechecks requester visibility, steering and driver permissions",
    async () => {
        const blocked = gate();
        let started = false;
        const app = await openCoreApp(
            scriptedModel(async (request) => {
                if (lastText(request as never).text.includes("hold")) {
                    started = true;
                    await blocked.promise;
                }

                return fauxAssistantMessage([fauxText("done")]);
            }),
            join(root, "queue-permissions"),
        );

        try {
            const source = await newSession(app);
            const target = await newSession(app);
            const emptySource = await newSession(app);
            const queue = sessionQueue(app);

            await assert.rejects(queue.list(emptySource, target), /No current requester/);
            await say(app, source, "ready");
            await app.commands.submit(target, owner(app), { text: "hold", requestId: "hold" });
            await until(() => started, "blocked model");
            const pending = await app.commands.submit(target, owner(app), {
                text: "pending",
                mode: "followUp",
                requestId: "pending",
            });
            const guest = app.config.addUser("Guest", "guest");

            const sent = await app.commands.submit(source, guest.user, {
                text: "guest",
                requestId: "guest",
            });

            await (await app.harness.submission(sent.submissionId, context))!.wait(context);
            app.config.updateUser(guest.user.id, { role: "viewer" });
            assert.equal((await queue.list(source, target)).length, 1);
            await assert.rejects(
                queue.withdraw(source, target, [Number(pending.submissionId)]),
                /not steer/,
            );
            app.config.updateUser(guest.user.id, { role: "guest" });
            await app.harness.commit(async (tx) => {
                const turns = await tx.doc(TurnsDoc, target);

                turns.on = true;
                turns.driver = owner(app).id;
            }, context);
            await assert.rejects(
                queue.withdraw(source, target, [Number(pending.submissionId)]),
                /turn|driv/i,
            );
            app.config.updateUser(guest.user.id, { sessions: [String(source)] });
            await assert.rejects(queue.list(source, target), /access|see|invited|shared/i);
        } finally {
            blocked.release();
            await app.close();
        }
    },
);
