import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTask, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import type { ChiefMessage } from "../src/server/chief.ts";
import { requestFor } from "../src/server/requests.ts";

after(cleanUp);

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

async function entries(app: Awaited<ReturnType<typeof openApp>>, id: ConversationId) {
    return (await (await app.conversation(id)).entries({}, 100, undefined, context)).items;
}

async function reports(app: Awaited<ReturnType<typeof openApp>>, id: ConversationId) {
    return (await entries(app, id)).filter(
        (entry) =>
            entry.kind === "pi.user" &&
            JSON.stringify(entry.model).includes("[Chief report from session"),
    );
}

async function receipt(app: Awaited<ReturnType<typeof openApp>>, request: ChiefMessage) {
    const key = createHash("sha256").update(request.key).digest("hex");

    return app.harness.commit(
        (tx) => tx.submissionByRequest(request.target, requestFor(owner(app).id, `chief-${key}`)),
        context,
    );
}

async function finish(app: Awaited<ReturnType<typeof openApp>>, ids: TaskId[]) {
    await Promise.all(ids.map((id) => app.harness.waitForTask(id, context)));
}

test("completion reports coalesce steers by answer, not text, and remain source/target scoped", async () => {
    const first = gate();
    const second = gate();
    const third = gate();
    let round = 0;
    const model = scriptedModel(async (request) => {
        const { text } = lastText(request as never);

        if (["work-start", "update-one", "update-two"].some((message) => text.includes(message))) {
            round++;
            await [first, second, third][round - 1]!.promise;

            return fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText("IDENTICAL FINAL")]);
    });
    const app = await openApp(model, join(root, "coalesced"));

    try {
        const source = await newSession(app);
        const otherSource = await newSession(app);
        const target = await newSession(app);

        await say(app, source, "ready");
        await say(app, otherSource, "ready");
        const initial: ChiefMessage = {
            target,
            text: "work-start",
            mode: "followUp",
            key: "initial",
        };
        const update: ChiefMessage = {
            target,
            text: "update-one",
            mode: "steer",
            key: "update-one",
        };
        const finalUpdate: ChiefMessage = {
            target,
            text: "update-two",
            mode: "steer",
            key: "update-two",
        };
        const otherUpdate: ChiefMessage = {
            target,
            text: "other-source",
            mode: "steer",
            key: "other",
        };
        const a = await app.chief.message(source, initial);

        await until(() => round === 1, "first generation blocked");
        const b = await app.chief.message(source, update);

        await until(async () => (await receipt(app, update)) !== undefined, "first steer admitted");
        first.release();
        await until(() => round === 2, "second generation blocked");
        const c = await app.chief.message(source, finalUpdate);

        await until(
            async () => (await receipt(app, finalUpdate)) !== undefined,
            "second steer admitted",
        );
        second.release();
        await until(() => round === 3, "third generation blocked");
        const d = await app.chief.message(otherSource, otherUpdate);

        await until(
            async () => (await receipt(app, otherUpdate)) !== undefined,
            "other source steer admitted",
        );
        third.release();
        await finish(app, [a.taskId, b.taskId, c.taskId, d.taskId]);
        const settled = await Promise.all(
            [initial, update, finalUpdate, otherUpdate].map((input) => receipt(app, input)),
        );
        const answers = settled.map((input) => {
            assert.ok(input?.type === "input" && input.status === "done");

            return input.answer;
        });

        assert.equal(new Set(answers).size, 1, "all messages really share one final answer");
        assert.equal((await reports(app, source)).length, 1);
        assert.equal((await reports(app, otherSource)).length, 1);
        assert.equal((await app.chief.message(source, initial)).taskId, a.taskId);
        assert.equal((await reports(app, source)).length, 1, "same call replay adds nothing");

        const later = await app.chief.message(source, {
            target,
            text: "separate-run",
            mode: "followUp",
            key: "later",
        });

        await finish(app, [later.taskId]);
        assert.equal(
            (await reports(app, source)).length,
            2,
            "same text, different answer survives",
        );
        const otherTarget = await newSession(app);
        const elsewhere = await app.chief.message(source, {
            target: otherTarget,
            text: "elsewhere",
            mode: "followUp",
            key: "elsewhere",
        });

        await finish(app, [elsewhere.taskId]);
        assert.equal((await reports(app, source)).length, 3, "another target survives");
        await (await app.conversation(otherTarget)).configure({ model: null }, context);
        const failures = await Promise.all(
            ["failure-one", "failure-two"].map((key) =>
                app.chief.message(source, {
                    target: otherTarget,
                    text: key,
                    mode: "followUp",
                    key,
                }),
            ),
        );

        await finish(
            app,
            failures.map((failure) => failure.taskId),
        );
        assert.equal((await reports(app, source)).length, 5, "failures remain per message");
        assert.equal(
            (await reports(app, source)).filter((entry) =>
                JSON.stringify(entry.model).includes("failed:"),
            ).length,
            2,
        );

        for (const id of [source, otherSource]) {
            assert.equal(
                (await entries(app, id)).filter((entry) => entry.kind === "pi.assistant").length,
                1,
            );
            assert.equal(app.requesterOf(id), owner(app).id, "passive reports retain requester");
        }
    } finally {
        first.release();
        second.release();
        third.release();
        await app.close();
    }
});

test("a busy follow-up receives its own completion even when answer text is identical", async () => {
    const blocked = gate();
    let started = false;
    const model = scriptedModel(async (request) => {
        if (lastText(request as never).text.includes("blocked-work")) {
            started = true;
            await blocked.promise;
        }

        return fauxAssistantMessage([fauxText("same answer text")]);
    });
    const app = await openApp(model, join(root, "busy-follow-up"));

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await say(app, source, "ready");
        const initial: ChiefMessage = {
            target,
            text: "blocked-work",
            mode: "followUp",
            key: "blocked",
        };
        const followUp: ChiefMessage = { target, text: "next-work", mode: "followUp", key: "next" };
        const first = await app.chief.message(source, initial);

        await until(() => started, "initial generation blocked");
        const second = await app.chief.message(source, followUp);

        await until(
            async () => (await receipt(app, followUp))?.status === "queued",
            "busy follow-up queued",
        );
        blocked.release();
        await finish(app, [first.taskId, second.taskId]);
        const inputs = await Promise.all([initial, followUp].map((input) => receipt(app, input)));
        const answers = inputs.map((input) => {
            assert.ok(input?.type === "input" && input.status === "done");

            return input.answer;
        });

        assert.notEqual(answers[0], answers[1]);
        const delivered = await reports(app, source);

        assert.equal(delivered.length, 2, "two actual completions must remain visible");
        assert.ok(
            delivered.every((entry) => JSON.stringify(entry.model).includes("same answer text")),
        );
        assert.equal(
            (await entries(app, source)).filter((entry) => entry.kind === "pi.assistant").length,
            1,
        );
    } finally {
        blocked.release();
        await app.close();
    }
});

test("report checkpoint recovery after durable delivery creates no second entry", async () => {
    const model = scriptedModel(() => fauxAssistantMessage([fauxText("recovered final")]));
    const data = join(root, "report-recovery");
    let app = await openApp(model, data);

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await say(app, source, "ready");
        const request: ChiefMessage = { target, text: "work", mode: "followUp", key: "recover" };
        const sent = await app.chief.message(source, request);

        await finish(app, [sent.taskId]);
        const input = await receipt(app, request);

        assert.ok(input?.type === "input" && input.status === "done");
        const original = (await reports(app, source)).map((entry) => entry.id);

        assert.equal(original.length, 1);
        const otherSource = await newSession(app);

        await say(app, otherSource, "ready");
        // Report-phase recovery before delivery, including an old checkpoint without answer identity.
        const oldCheckpoint = defineTask({
            ...app.chief.task.definition,
            initial: (): ReturnType<typeof app.chief.task.definition.initial> => ({
                phase: "report",
                text: "recovered final",
            }),
        });
        const newCheckpoint = defineTask({
            ...app.chief.task.definition,
            initial: () => ({
                phase: "report" as const,
                text: "recovered final",
                answer: input.answer,
            }),
        });
        const pending = await app.harness.commit(async (tx) => {
            const admitted = { ...request, ownerId: owner(app).id };
            const options = {
                ownership: { kind: "conversation" as const },
                conversationId: otherSource,
                background: true,
            };
            const old = await tx.createTask(oldCheckpoint, admitted, options);
            const current = await tx.createTask(newCheckpoint, admitted, options);

            return [old, current];
        }, context);

        await finish(app, pending);
        const recovered = (await reports(app, otherSource)).map((entry) => entry.id);

        assert.equal(
            recovered.length,
            1,
            "old and new pending report checkpoints share one delivery",
        );

        for (const legacyKey of [
            undefined,
            `chief-report:${sent.taskId}`,
            requestFor(owner(app).id, `chief-report-${sent.taskId}`),
        ]) {
            await app.close();
            // Disposable crash-boundary fixture: delivery committed, terminal checkpoint did not.
            const db = new DatabaseSync(join(data, "pocket.sqlite"));

            try {
                for (const id of [sent.taskId, ...pending]) {
                    const row = db.prepare("SELECT record FROM tasks WHERE id = ?").get(id)!;
                    const record = JSON.parse(row.record as string);

                    record.state = {
                        status: "running",
                        checkpoint: {
                            phase: "report",
                            text: "recovered final",
                            ...(id === pending[0] ? {} : { answer: input.answer }),
                        },
                    };
                    db.prepare("UPDATE tasks SET status = 'running', record = ? WHERE id = ?").run(
                        JSON.stringify(record),
                        id,
                    );
                }

                if (legacyKey !== undefined) {
                    const row = db
                        .prepare(
                            "SELECT id, record FROM submissions WHERE conversation_id = ? AND json_extract(record, '$.entry') = ?",
                        )
                        .get(source, original[0]!)!;
                    const record = JSON.parse(row.record as string);

                    record.requestId = legacyKey;
                    db.prepare(
                        "UPDATE submissions SET request_id = ?, record = ? WHERE id = ?",
                    ).run(JSON.stringify(legacyKey), JSON.stringify(record), row.id as number);
                }
            } finally {
                db.close();
            }

            app = await openApp(model, data);
            await finish(app, [sent.taskId, ...pending]);
            assert.deepEqual(
                (await reports(app, source)).map((entry) => entry.id),
                original,
            );
            assert.deepEqual(
                (await reports(app, otherSource)).map((entry) => entry.id),
                recovered,
            );
            assert.equal(
                (await entries(app, otherSource)).filter((entry) => entry.kind === "pi.assistant")
                    .length,
                1,
            );
        }

        assert.equal((await app.chief.message(source, request)).taskId, sent.taskId);
        assert.equal(
            (await entries(app, source)).filter((entry) => entry.kind === "pi.assistant").length,
            1,
        );
        assert.equal(app.requesterOf(source), owner(app).id);
    } finally {
        await app.close();
    }
});
