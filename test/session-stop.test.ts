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
import { openApp, test } from "./owner-sessions.ts";
import { TurnsDoc, ChiefMessagesDoc } from "../src/server/docs.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { after, test as coreTest } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { ConfigStore } from "../src/server/config.ts";

after(cleanUp);

coreTest("stop reuses requester visibility and steering, but not driver permission", async () => {
    const app = await openCoreApp(scriptedModel(), join(root, "stop-permissions"));

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await assert.rejects(app.chief.stop(source, target), /No current requester/);
        const guest = app.config.addUser("Guest", "guest", [String(source)]);

        await app.commands.submit(source, guest.user, { text: "ready", requestId: "ready" });
        await (await app.conversation(source)).waitForIdle(context);
        await assert.rejects(app.chief.stop(source, target), /not shared/);
        app.config.updateUser(guest.user.id, { sessions: [String(source), String(target)] });
        await app.harness.commit(async (tx) => {
            const turns = await tx.doc(TurnsDoc, target);

            turns.on = true;
            turns.driver = owner(app).id;
        }, context);
        assert.deepEqual(await app.chief.stop(source, target), {
            sessionId: target,
            stopRequested: true,
        });
        app.config.updateUser(guest.user.id, { role: "viewer" });
        await assert.rejects(app.chief.stop(source, target), /not steer/);
        app.config.updateUser(guest.user.id, { role: "guest" });
        await assert.rejects(app.chief.stop(source, 999999 as typeof target), /No project session/);
    } finally {
        await app.close();
    }
});

test("installed stop cancels a running tool, withdraws queued input, preserves writes/history and reports failure once", async () => {
    const pidFile = join(root, "stop-pid");
    const endFile = join(root, "stop-end");
    const model = scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        if (role !== "toolResult" && text.includes("hold-tool")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("bash", {
                        command: `echo $$ > ${pidFile}; sleep 60; touch ${endFile}`,
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role !== "toolResult" && text.startsWith("stop:")) {
            return fauxAssistantMessage(
                [fauxToolCall("sessions", { action: "stop", sessionId: Number(text.slice(5)) })],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText("done")]);
    });
    const app = await openApp(model, join(root, "stop-tool"));

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await say(app, source, "ready");
        await say(app, target, "retained history");
        const meta = { ...app.sessionMeta(target) };

        await app.chief.message(source, {
            target,
            text: "hold-tool",
            mode: "followUp",
            key: "held",
        });
        await until(() => existsSync(pidFile), "active shell tool");
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        const queued = await app.commands.submit(target, owner(app), {
            text: "queued",
            requestId: "queued",
        });
        const passive = await (
            await app.conversation(target)
        ).submit({ type: "write", entry: { kind: "stop-test.passive", data: "keep" } }, context);

        await say(app, source, `stop:${target}`);
        await until(() => {
            try {
                process.kill(pid, 0);

                return false;
            } catch {
                return true;
            }
        }, "shell process cancellation");
        assert.equal(existsSync(endFile), false);
        await (await app.conversation(target)).waitForIdle(context);
        const settled = await (await app.harness.submission(queued.submissionId, context))!.wait(
            context,
        );

        assert.equal(settled.status, "unanswered");
        assert.ok(settled.status === "unanswered" && settled.reason === "aborted");
        // Passive writes survive stop; a later run can place them.
        await say(app, target, "resume after stop");
        assert.equal((await passive.wait(context)).status, "done");
        const reports = (await app.harness.snapshot(ChiefMessagesDoc, source, context))!.items;

        for (const task of Object.values(reports)) {
            await app.harness.waitForTask(task, context);
        }

        assert.equal(
            (await modelTexts(app, source)).filter(
                (text) =>
                    text.includes("Chief report from session") && text.includes("failed: aborted"),
            ).length,
            1,
        );
        assert.ok(
            (await modelTexts(app, target)).some((text) => text.includes("retained history")),
        );
        const entries = await (await app.conversation(target)).entries({}, 100, undefined, context);

        assert.ok(entries.items.some((entry) => entry.kind === "stop-test.passive"));
        assert.equal(app.sessionMeta(target)?.cwd, meta.cwd);
        assert.equal(app.sessionMeta(target)?.archived, meta.archived);
        await say(app, source, `stop:${target}`);
        await say(app, target, "work after idle stop");
    } finally {
        await app.close();
    }
});

coreTest("native stop cancels an active model request and stays usable after reopen", async () => {
    let started = false;
    let aborted = false;
    const model = scriptedModel(async (request, options) => {
        const { text } = lastText(request as never);

        if (text.includes("hold-model")) {
            started = true;
            await new Promise<void>((resolve) => {
                options?.signal?.addEventListener(
                    "abort",
                    () => {
                        aborted = true;
                        resolve();
                    },
                    { once: true },
                );
            });
        }

        return fauxAssistantMessage([fauxText("done")]);
    });
    const data = join(root, "stop-model");
    let app = await openCoreApp(model, data);

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await say(app, source, "ready");
        const active = await app.commands.submit(target, owner(app), {
            text: "hold-model",
            requestId: "model",
        });

        await until(() => started, "active model");
        await app.chief.stop(source, target);
        await until(() => aborted, "model signal cancellation");
        await (await app.conversation(target)).waitForIdle(context);
        const settled = await (await app.harness.submission(active.submissionId, context))!.wait(
            context,
        );

        assert.ok(settled.status === "unanswered" && settled.reason === "aborted");
        await app.close();
        app = await openCoreApp(model, data);
        await app.chief.stop(source, target);
        await say(app, target, "new work after reopen");
        assert.ok(
            (await modelTexts(app, target)).some((text) => text.includes("new work after reopen")),
        );
    } finally {
        await app.close();
    }
});

test("native stop follows ordinary owned children but excludes background ownership", async () => {
    const data = join(root, "stop-owned");
    const directory = join(data, "extensions");
    const modulePath = join(directory, "stop-anchor.ts");

    mkdirSync(directory, { recursive: true });
    writeFileSync(
        modulePath,
        `/** Test anchors for native ownership boundaries. */
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
export const anchor = defineTask({ name: "test.stop-anchor", version: 1, initial: () => ({ phase: "hold" }),
    phases: { hold: async (_task, _runtime, context) => awaitWithContext(new Promise(() => {}), context) }
});
export default () => defineExtension({ name: "test-stop-anchor", tasks: [anchor] });`,
    );
    new ConfigStore(data).setExtensionEnabled("stop-anchor.ts", true);
    const starts = new Set<string>();
    const aborts = new Set<string>();
    const releases: (() => void)[] = [];
    const model = scriptedModel(async (request, options) => {
        const { text } = lastText(request as never);

        if (text.startsWith("hold-")) {
            starts.add(text);
            await new Promise<void>((resolve) => {
                releases.push(resolve);
                options?.signal?.addEventListener(
                    "abort",
                    () => {
                        aborts.add(text);
                        resolve();
                    },
                    { once: true },
                );
            });
        }

        return fauxAssistantMessage([fauxText("done")]);
    });
    const app = await openApp(model, data);

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await say(app, source, "ready");
        const { anchor } = await import(pathToFileURL(modulePath).href);
        const children = [];

        for (const background of [false, true]) {
            const child = await app.harness.commit(async (tx) => {
                const taskId = await tx.createTask(anchor, null, {
                    ownership: { kind: "conversation" },
                    conversationId: target,
                    background,
                });

                return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
            }, context);
            const conversation = await app.conversation(child);

            await conversation.submit(
                { type: "input", content: background ? "hold-background" : "hold-ordinary" },
                context,
            );
            children.push({ background, child, conversation });
        }

        await until(() => starts.size === 2, "owned models");
        const queues = [];

        for (const child of children) {
            queues.push(
                await child.conversation.submit(
                    { type: "input", content: "pending child work" },
                    context,
                ),
            );
        }

        await app.chief.stop(source, target);
        await (await app.conversation(target)).waitForIdle(context);
        assert.ok(aborts.has("hold-ordinary"));
        assert.equal(aborts.has("hold-background"), false);
        const ordinary = await queues[0]!.wait(context);

        assert.ok(ordinary.status === "unanswered" && ordinary.reason === "aborted");
        assert.equal((await queues[1]!.status(context)).status, "queued");
    } finally {
        for (const release of releases) {
            release();
        }

        await app.close();
    }
});

for (const receipt of [false, true]) {
    test(`native recovery of ${receipt ? "receipt" : "intent-only"} stop never aborts later active work`, async () => {
        const data = join(root, receipt ? "stop-receipt-recovery" : "stop-intent-recovery");
        const directory = join(data, "extensions");
        const marker = join(data, "paused");
        const wrapper = join(directory, "pause-stop.ts");

        mkdirSync(directory, { recursive: true });
        writeFileSync(
            wrapper,
            `/** Test-only pause after a persisted stop memo. */
import { defineExtension } from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
import { writeFileSync } from "node:fs";
export default () => defineExtension({ name: "test-stop-pause", wraps: [{ tool: "sessions", wrap: tool => ({
    ...tool, execute: (args, api, context) => tool.execute(args, { ...api, memo: async (...params) => {
        const value = await api.memo(...params);
        if (args.action === "stop" && params.length === 3 && params[0].startsWith(${JSON.stringify(receipt ? "stop-result:" : "stop:")})) {
            writeFileSync(${JSON.stringify(marker)}, "persisted");
            await awaitWithContext(new Promise(() => {}), context);
        }
        return value;
    } }, context)
}) }] });`,
        );
        new ConfigStore(data).setExtensionEnabled("pause-stop.ts", true);
        let release!: () => void;
        let modelStarts = 0;
        const model = scriptedModel(async (request, options) => {
            const { role, text } = lastText(request as never);

            if (text.includes("later-model")) {
                modelStarts++;
                await new Promise<void>((resolve) => {
                    release = resolve;
                    options?.signal?.addEventListener("abort", () => resolve(), { once: true });
                });
            }

            if (role !== "toolResult" && text.startsWith("stop:")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("sessions", {
                            action: "stop",
                            sessionId: Number(text.slice(5)),
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage([fauxText("done")]);
        });
        let app = await openApp(model, data);

        try {
            const source = await newSession(app);
            const target = await newSession(app);

            await say(app, source, "ready");
            await app.commands.submit(source, owner(app), {
                text: `stop:${target}`,
                requestId: "interrupted-stop",
            });
            await until(() => existsSync(marker), "persisted stop memo");
            const later = await app.commands.submit(target, owner(app), {
                text: "later-model",
                requestId: "later-work",
            });

            await until(() => modelStarts === 1, "later active work");
            await app.close();
            rmSync(wrapper);
            app = await openApp(model, data);
            await until(() => modelStarts === 2, "later work resumed");
            await (await app.conversation(source)).waitForIdle(context);
            const settled = await (await app.harness.submission(
                later.submissionId,
                context,
            ))!.status(context);

            assert.equal(settled.status, "placed", "replayed stop must not cancel later work");
            assert.equal(app.isBusy(target), true);
            const texts = await modelTexts(app, source);

            assert.ok(
                texts.some((text) =>
                    text.includes(
                        receipt ? "stopRequested" : "Stop was interrupted and may have run",
                    ),
                ),
            );
            release();
            await (await app.conversation(target)).waitForIdle(context);
        } finally {
            release?.();
            await app.close();
        }
    });
}
