import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { UserEntry, ResetEntry, type ConversationId } from "@earendil-works/pi-durable";
import {
    TreeMemoryDoc,
    TreeNodeDoc,
    evidence,
    nodeKey,
    renderView,
    bytes,
    requestTokens,
    type Ref,
} from "../src/server/tree-memory.ts";

after(cleanUp);
const compactor = (messages: readonly Message[]) =>
    JSON.stringify(messages).includes("Compaction: summarize");
const mainRequest = (messages: readonly Message[]) =>
    JSON.stringify(messages).includes("Historical memory");
const parentRequest = (messages: readonly Message[]) =>
    /Compaction: summarize \d+\+(?:2|4|8|16|32|64|128|256)/.test(JSON.stringify(messages));

async function seed(app: App, old = "old decision: cobalt") {
    copyFileSync("extensions/tree-memory.ts", join(app.dataDir, "extensions/tree-memory.ts"));
    await app.setExtensionEnabled(owner(app), "tree-memory.ts", true);
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        const entry = await tx.appendEntry(UserEntry, id, {
            model: [{ role: "user", content: old, timestamp: 0 }],
        });

        Object.assign(await tx.doc(TreeMemoryDoc, id), {
            enabled: true,
            phase: "ready",
            model: { provider: "faux", modelId: "faux-2" },
            count: 1,
            appended: 1,
            cursor: entry.id,
            main: [{ id: 0, n: 1, text: old }],
            compactor: [{ id: 0, n: 1, text: old }],
        });
        Object.assign(await tx.doc(TreeNodeDoc, id, "0+1", {}), {
            entry: entry.id,
            part: 0,
            start: 0,
            end: evidence(entry.model![0]!).length,
            text: old,
        });
    }, context);

    return id;
}

async function submit(app: App, id: ConversationId, text: string) {
    return app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });
}

async function ask(app: App, id: ConversationId, text: string) {
    const sent = await submit(app, id, text);

    return (await app.harness.submission(sent.submissionId, context))!.wait(context);
}

async function drained(app: App, id: ConversationId) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const tail = (
        await (await app.harness.conversation(id, context))!.entries({}, 1, undefined, context)
    ).items[0]!.id;

    await until(
        async () => {
            const state = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;
            const worker =
                state.worker === undefined
                    ? undefined
                    : await app.harness.getTask(state.worker, context);

            if (
                state.error &&
                worker?.state.status === "terminal" &&
                worker.state.outcome.status === "failed"
            ) {
                throw Error(state.error);
            }

            return (
                state.cursor >= tail &&
                state.appended === state.count &&
                state.queue.length === 0 &&
                (worker === undefined || worker.state.status === "terminal")
            );
        },
        "autonomous saved summary frontier",
        15000,
    );
}

test("token-aware budget admits a >255616-byte native tool turn intact, not by stale usage", async (t) => {
    const body = '"synthetic payload value" '.repeat(1600);
    const path = join(root, "token-budget-tool.txt");
    const requests: Message[][] = [];

    writeFileSync(path, body);
    const provider = scriptedModel((request) => {
        if (compactor(request.messages)) {
            return fauxAssistantMessage("saved summary");
        }

        if (mainRequest(request.messages)) {
            requests.push(structuredClone([...request.messages]));

            if (requests.length === 1) {
                return fauxAssistantMessage(
                    Array.from({ length: 4 }, () => fauxToolCall("read", { path })),
                    { stopReason: "toolUse" },
                );
            }
        }

        return fauxAssistantMessage("TOKEN_BUDGET_DONE");
    });

    provider.models[0].contextWindow = 272000;
    const app = await openApp(provider, join(root, "token-budget-native"));

    try {
        const id = await seed(app);

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(TreeMemoryDoc, id);

            for (let i = 1; i <= 130; i++) {
                const content =
                    `old synthetic fact ${i} ` +
                    "p".repeat(494 - `old synthetic fact ${i} `.length);
                const entry = await tx.appendEntry(UserEntry, id, {
                    model: [{ role: "user", content, timestamp: i }],
                });
                const text = evidence(entry.model![0]!);

                Object.assign(await tx.doc(TreeNodeDoc, id, `${i}+1`, {}), {
                    entry: entry.id,
                    part: 0,
                    start: 0,
                    end: text.length,
                    text,
                });
                state.main.push({ id: i, n: 1, text });
                state.cursor = entry.id;
            }

            Object.assign(state, {
                count: 131,
                appended: 131,
                compactor: [{ id: 0, n: 128, text: "older summary" }, ...state.main.slice(128)],
            });
        }, context);
        const receipt = await ask(app, id, "SYNTHETIC_TOKEN_BUDGET_QUERY");

        assert.equal(receipt.status, "done", JSON.stringify(receipt));
        assert.equal(
            requests.length,
            2,
            "second actual native dispatch follows complete tool results",
        );
        const request = requests[1]!;
        const estimate = request.reduce(
            (sum, message) => sum + estimateMessageTokens(message) + 16,
            0,
        );

        assert.ok(bytes(JSON.stringify(request)) > 255616);
        assert.ok(estimate > 55000 && estimate < 75000, `fresh tokens: ${estimate}`);
        assert.ok(requestTokens(request) < 255616);
        const results = request.filter((message) => message.role === "toolResult");
        const assistant = request.find((message) => message.role === "assistant")!;

        assert.equal(results.length, 4);
        assert.equal(assistant.content.filter((part) => part.type === "toolCall").length, 4);
        assert.deepEqual(
            results.map((message) => message.toolCallId),
            assistant.content.filter((part) => part.type === "toolCall").map((part) => part.id),
        );
        assert.ok(
            results.every((message) =>
                message.content.some((part) => part.type === "text" && part.text.includes(body)),
            ),
            "all original tool output intact",
        );
        assert.deepEqual(request[1], requests[0]![1], "historical frozen summaries unchanged");
        t.diagnostic(
            JSON.stringify({
                jsonBytes: bytes(JSON.stringify(request)),
                freshTokens: estimate,
                guardedTokens: requestTokens(request),
                toolResults: results.length,
            }),
        );
    } finally {
        await app.close();
    }
});

test("fresh token estimate counts system schemas, Unicode, thinking and media without JSON/base64 or usage inflation", () => {
    const assistant = fauxAssistantMessage([
        { type: "thinking", thinking: "λ".repeat(100), thinkingSignature: "opaque".repeat(50000) },
        fauxToolCall("read", { path: "合成" }),
    ]);
    const messages: Message[] = [
        {
            role: "system",
            content: "",
            sections: { instructions: "synthetic rules".repeat(100) },
            toolsAdded: [
                {
                    name: "read",
                    description: "synthetic schema".repeat(100),
                    parameters: { type: "object", properties: { path: { type: "string" } } },
                },
            ],
            timestamp: 0,
        },
        {
            role: "user",
            content: [
                { type: "text", text: "漢字🙂".repeat(100) },
                { type: "image", mimeType: "image/png", data: "A".repeat(300000) },
            ],
            timestamp: 0,
        },
        assistant,
    ];
    const fresh = messages.reduce((sum, message) => sum + estimateMessageTokens(message) + 16, 0);

    assert.ok(bytes(JSON.stringify(messages)) > 255616);
    assert.equal(requestTokens(messages), Math.ceil(fresh * 1.25));
    assert.ok(
        requestTokens(messages) < 10000,
        "native fixed image estimate, not base64 byte count",
    );
    const before = requestTokens(messages);

    assistant.usage = { ...assistant.usage, input: 1000000, totalTokens: 1000000 };
    assert.equal(
        requestTokens(messages),
        before,
        "never use last response usage as projected-input size",
    );
    assert.ok(
        requestTokens(messages.slice(0, 1)) >
            requestTokens([{ role: "system", content: "", timestamp: 0 }]),
        "sections and full tool schemas counted",
    );
    assert.ok(
        requestTokens(messages) > requestTokens([messages[0]!, assistant]),
        "Unicode and image both contribute",
    );
});

test("compressor token allowance still refuses oversized source before dispatch", async () => {
    let calls = 0;
    const provider = scriptedModel((request) => {
        if (compactor(request.messages)) {
            calls++;
        }

        return fauxAssistantMessage("summary");
    });

    provider.models[1]!.contextWindow = 10240;
    const app = await openApp(provider, join(root, "token-budget-compressor"));

    try {
        const id = await seed(app);

        await app.harness.commit(
            (tx) =>
                tx.appendEntry(UserEntry, id, {
                    model: [{ role: "user", content: "source ".repeat(2000), timestamp: 1 }],
                }),
            context,
        );
        await until(
            async () =>
                (await app.harness.snapshot(TreeMemoryDoc, id, context))!.error !== undefined,
            "compressor token guard",
        );
        const tasks = await app.harness.commit(
            (tx) => tx.scanTasks({ conversationId: id, kind: "pocket.tree-build" }, 10),
            context,
        );

        assert.ok(
            tasks.items.some(
                (task) =>
                    task.state.status === "terminal" &&
                    task.state.outcome.status === "faulted" &&
                    /bounded compressor input/.test(task.state.outcome.error.message),
            ),
        );
        assert.equal(calls, 0);
    } finally {
        await app.close();
    }
});

test("next turn waits for preceding leaf; saved prompt is summary-only; unrelated parent never blocks; only appends below batch threshold", async () => {
    let releaseLeaf!: () => void;
    let releaseParent!: () => void;
    const leafHeld = new Promise<void>((resolve) => {
        releaseLeaf = resolve;
    });
    const parentHeld = new Promise<void>((resolve) => {
        releaseParent = resolve;
    });
    let leafEntered = false;
    let parentEntered = false;
    const requests: Message[][] = [];
    const app = await openApp(
        scriptedModel(async (request) => {
            if (compactor(request.messages)) {
                if (parentRequest(request.messages)) {
                    parentEntered = true;
                    await parentHeld;

                    return fauxAssistantMessage(
                        "built parent, not an individual prompt replacement",
                    );
                }

                leafEntered = true;
                await leafHeld;

                return fauxAssistantMessage("APPROVAL_731 " + "s".repeat(460));
            }

            if (mainRequest(request.messages)) {
                requests.push(structuredClone([...request.messages]));
            }

            return fauxAssistantMessage("ANSWER_OK");
        }),
        join(root, "stable-required-leaf"),
    );

    try {
        const id = await seed(app, "old_".repeat(100));
        const original = await app.harness.commit(
            (tx) =>
                tx.appendEntry(UserEntry, id, {
                    model: [{ role: "user", content: "raw_historical_".repeat(300), timestamp: 1 }],
                }),
            context,
        );

        await until(() => leafEntered, "idle-time leaf started without new input");
        const sent = await submit(app, id, "NEXT_WAIT_QUERY");

        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
            requests.length,
            0,
            "no raw-tail prompt swapping while required summary is missing",
        );
        releaseLeaf();
        const receipt = await (await app.harness.submission(sent.submissionId, context))!.wait(
            context,
        );

        assert.equal(receipt.status, "done", JSON.stringify(receipt));
        const fresh = requests.find((messages) =>
            JSON.stringify(messages).includes("NEXT_WAIT_QUERY"),
        )!;

        assert.ok(fresh, "fresh actual native provider request");
        assert.ok(!JSON.stringify(fresh).includes("raw_historical_"));
        assert.ok(JSON.stringify(fresh[1]).includes("APPROVAL_731"));
        assert.equal(fresh.filter((message) => message.role === "user").length, 2);
        await until(() => parentEntered, "unnecessary parent remains pending");
        const saved = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;

        assert.notEqual(
            (await app.harness.getTask(saved.worker!, context))!.state.status,
            "terminal",
        );
        const prefix = saved.main.slice(0, 2);
        const pin = saved.turn!.frozen;

        await until(
            async () => (await app.harness.snapshot(TreeMemoryDoc, id, context))!.count === 4,
            "completed first turn admitted",
        );
        await app.harness.commit(async (tx) => {
            for (let i = 0; i < 12; i++) {
                await tx.appendEntry(UserEntry, id, {
                    model: [{ role: "user", content: `idle appended fact ${i}`, timestamp: i + 2 }],
                });
            }
        }, context);
        await until(async () => {
            const state = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;

            return state.count === 16 && state.appended === 16;
        }, "more than one worker wave of completed leaves publishes while unrelated parent is held");
        assert.equal((await app.harness.snapshot(TreeMemoryDoc, id, context))!.turn!.frozen, pin);

        assert.equal(
            (await app.treeMemory.zoom(id, 1, 1, 0, context)).text,
            evidence(original.model![0]!),
        );
        releaseParent();
        await drained(app, id);
        const built = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;

        assert.deepEqual(
            built.main.slice(0, 2),
            prefix,
            "built parent never replaces individual saved rows",
        );
        assert.equal(built.turn!.frozen, pin, "background publication never edits the frozen turn");
        assert.equal((await ask(app, id, "FOLLOWING_QUERY")).status, "done");
        const next = requests.find((messages) =>
            JSON.stringify(messages).includes("FOLLOWING_QUERY"),
        )!;

        assert.ok(
            JSON.stringify(next[1]).includes("NEXT_WAIT_QUERY"),
            "previous completed turn appended to saved summary view",
        );
        assert.ok(!JSON.stringify(next).includes("raw_historical_"));
    } finally {
        releaseLeaf();
        releaseParent();
        await app.close();
    }
});

test("unneeded parent failure during a tool turn does not invalidate its already frozen summary request", async () => {
    let releaseParent!: () => void;
    let releaseMain!: () => void;
    const parentHeld = new Promise<void>((resolve) => {
        releaseParent = resolve;
    });
    const mainHeld = new Promise<void>((resolve) => {
        releaseMain = resolve;
    });
    let parentEntered = false;
    let mainEntered = false;
    const requests: Message[][] = [];
    const path = join(root, "stable-parent-tool.txt");

    writeFileSync(path, "native paired result");
    const app = await openApp(
        scriptedModel(async (request) => {
            if (compactor(request.messages)) {
                if (parentRequest(request.messages)) {
                    parentEntered = true;
                    await parentHeld;

                    return fauxAssistantMessage("", {
                        stopReason: "error",
                        errorMessage: "unneeded parent failed",
                    });
                }

                return fauxAssistantMessage("leaf " + "s".repeat(460));
            }

            if (mainRequest(request.messages)) {
                requests.push(structuredClone([...request.messages]));

                if (requests.length === 1) {
                    mainEntered = true;
                    await mainHeld;

                    return fauxAssistantMessage([fauxToolCall("read", { path })], {
                        stopReason: "toolUse",
                    });
                }
            }

            return fauxAssistantMessage("PARENT_FAULT_TURN_DONE");
        }),
        join(root, "stable-parent-fault-turn"),
    );

    try {
        const id = await seed(app, "old_".repeat(100));

        await app.harness.commit(
            (tx) =>
                tx.appendEntry(UserEntry, id, {
                    model: [{ role: "user", content: "long_original_".repeat(100), timestamp: 1 }],
                }),
            context,
        );
        await until(() => parentEntered, "optional parent pending");
        const sent = await submit(app, id, "PARENT_FAULT_CURRENT");

        await until(() => mainEntered, "first actual native tool request held");
        releaseParent();
        await until(
            async () => (await app.harness.snapshot(TreeMemoryDoc, id, context))!.phase === "error",
            "parent failure visible",
        );
        releaseMain();
        const receipt = await (await app.harness.submission(sent.submissionId, context))!.wait(
            context,
        );

        assert.equal(receipt.status, "done", JSON.stringify(receipt));
        assert.equal(requests.length, 2);
        assert.equal(requests[0]![1]!.content, requests[1]![1]!.content);
        assert.equal(requests[1]!.filter((message) => message.role === "toolResult").length, 1);
        assert.ok(!JSON.stringify(requests).includes("long_original_"));
    } finally {
        releaseParent();
        releaseMain();
        await app.close();
    }
});

test("completed reply starts durable background summaries during idle time, never summarizes the active turn into its own prompt", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered = false;
    let calls = 0;
    const app = await openApp(
        scriptedModel(async (request) => {
            if (compactor(request.messages)) {
                calls++;

                return fauxAssistantMessage("saved completed-turn decision");
            }

            if (mainRequest(request.messages)) {
                entered = true;
                await held;
            }

            return fauxAssistantMessage("reply_body_".repeat(150));
        }),
        join(root, "stable-after-reply"),
    );

    try {
        const id = await seed(app);
        const sent = await submit(app, id, "active_current_body_".repeat(150));

        await until(() => entered, "native reply pending");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(calls, 0);
        assert.equal((await app.harness.snapshot(TreeMemoryDoc, id, context))!.count, 1);
        release();
        const receipt = await (await app.harness.submission(sent.submissionId, context))!.wait(
            context,
        );

        assert.equal(receipt.status, "done", JSON.stringify(receipt));
        await until(() => calls >= 2, "user/assistant summaries start without next user input");
        await drained(app, id);
        const state = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;

        assert.equal(state.count, 3);
        assert.equal(state.appended, 3);
        assert.ok(state.worker !== undefined);
    } finally {
        release();
        await app.close();
    }
});

test("failed required compressor pauses; next input retries once then fails closed, never dispatches an incomplete summary view", async () => {
    let calls = 0;
    const requests: string[] = [];
    const app = await openApp(
        scriptedModel((request) => {
            if (compactor(request.messages)) {
                calls++;

                return fauxAssistantMessage("", {
                    stopReason: "error",
                    errorMessage: "genuine provider failure",
                });
            }

            if (mainRequest(request.messages)) {
                requests.push(JSON.stringify(request.messages));
            }

            return fauxAssistantMessage("answer");
        }),
        join(root, "stable-failure"),
    );

    try {
        const id = await seed(app);

        await app.harness.commit(
            (tx) =>
                tx.appendEntry(UserEntry, id, {
                    model: [
                        { role: "user", content: "failed_historical_".repeat(150), timestamp: 1 },
                    ],
                }),
            context,
        );
        await until(
            async () =>
                (await app.harness.snapshot(TreeMemoryDoc, id, context))?.error !== undefined,
            "idle compressor paused",
        );
        const receipt = await ask(app, id, "MUST_WAIT_FOR_SUMMARY");

        assert.equal(receipt.status, "unanswered", JSON.stringify(receipt));
        assert.equal(requests.length, 0);
        await until(() => calls === 2, "one authorized next-input retry");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(calls, 2, "no passive retry loop");
        assert.match(
            (await app.harness.snapshot(TreeMemoryDoc, id, context))!.error!,
            /genuine provider failure/,
        );
    } finally {
        await app.close();
    }
});

test("historical backlog larger than main allowance waits for complete summaries; oversized active input is refused", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered = false;
    const requests: string[] = [];
    const provider = scriptedModel(async (request) => {
        if (compactor(request.messages)) {
            entered = true;
            await held;

            return fauxAssistantMessage("SUMMARY_BUDGET_DECISION");
        }

        if (mainRequest(request.messages)) {
            requests.push(JSON.stringify(request.messages));
        }

        return fauxAssistantMessage("BUDGET_OK");
    });

    provider.models[0].contextWindow = 32768;
    const app = await openApp(provider, join(root, "stable-budget"));

    app.settings.applyOverrides({ compaction: { reserveTokens: 1000 } });

    try {
        const id = await seed(app);

        await app.harness.commit(
            (tx) =>
                tx.appendEntry(UserEntry, id, {
                    model: [
                        { role: "user", content: "huge_historical_".repeat(7000), timestamp: 1 },
                    ],
                }),
            context,
        );
        await until(() => entered, "historical source held");
        const sent = await submit(app, id, "BUDGET_CURRENT_QUERY");

        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 0);
        release();
        const receipt = await (await app.harness.submission(sent.submissionId, context))!.wait(
            context,
        );

        assert.equal(receipt.status, "done", JSON.stringify(receipt));
        assert.ok(!requests[0]!.includes("huge_historical_"));
        assert.ok(requests[0]!.includes("SUMMARY_BUDGET_DECISION"));
        await drained(app, id);
        const oversized = await ask(app, id, "ACTIVE_OVERFLOW_".repeat(16000));

        assert.equal(oversized.status, "unanswered", JSON.stringify(oversized));
        assert.ok(!requests.some((request) => request.includes("ACTIVE_OVERFLOW_")));
    } finally {
        release();
        await app.close();
    }
});

test("startup discovers committed-but-unnotified history exactly once without new input", async () => {
    const route = (request: { messages: readonly Message[] }) =>
        fauxAssistantMessage(compactor(request.messages) ? "RECOVERED_SUMMARY" : "answer");
    const data = join(root, "stable-recovery");
    let app = await openApp(scriptedModel(route), data);

    try {
        const id = await seed(app);

        app.treeMemory.arrived = async () => {};

        const original = await app.harness.commit(
            (tx) =>
                tx.appendEntry(UserEntry, id, {
                    model: [
                        { role: "user", content: "missed_notification_".repeat(100), timestamp: 1 },
                    ],
                }),
            context,
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal((await app.harness.snapshot(TreeMemoryDoc, id, context))!.count, 1);
        await app.close();
        app = await openApp(scriptedModel(route), data);
        await drained(app, id);
        const state = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;

        assert.equal(state.count, 2);
        assert.equal(state.cursor, original.id);
        assert.equal(
            (await app.harness.snapshot(TreeNodeDoc, id, "1+1", context))!.entry,
            original.id,
        );
        await Promise.all([
            app.treeMemory.arrived(id, context),
            app.treeMemory.arrived(id, context),
        ]);
        assert.equal((await app.harness.snapshot(TreeMemoryDoc, id, context))!.count, 2);
    } finally {
        await app.close();
    }
});

test("deferred publication safety; a lost notification still waits and sends only the saved summary", async () => {
    const requests: string[] = [];
    const app = await openApp(
        scriptedModel((request) => {
            if (compactor(request.messages)) {
                return fauxAssistantMessage("UNNOTIFIED_SUMMARY");
            }

            if (mainRequest(request.messages)) {
                requests.push(JSON.stringify(request.messages));
            }

            return fauxAssistantMessage("answer");
        }),
        join(root, "stable-deferred"),
    );
    let unsubscribe: (() => void) | undefined;

    try {
        const id = await seed(app);

        await new Promise<void>((resolve) => setImmediate(resolve));
        let returned = false;
        let calls = 0;

        app.treeMemory.arrived = async (_id, receivedContext) => {
            assert.ok(returned, "no synchronous Harness call from publication");
            assert.equal(receivedContext, context);
            calls++;
        };

        unsubscribe = app.harness.subscribeCommits((publication) => {
            if (
                publication.changes.some(
                    (change) =>
                        change.type === "entry" &&
                        JSON.stringify(change.value.model).includes("UNNOTIFIED_RAW"),
                )
            ) {
                assert.equal(calls, 0);
            }
        });
        await app.harness.commit(
            (tx) =>
                tx.appendEntry(UserEntry, id, {
                    model: [{ role: "user", content: "UNNOTIFIED_RAW ".repeat(100), timestamp: 1 }],
                }),
            context,
        );
        returned = true;
        await until(() => calls > 0, "deferred arrival");
        assert.equal((await app.harness.snapshot(TreeMemoryDoc, id, context))!.count, 1);
        assert.equal((await ask(app, id, "UNNOTIFIED_CURRENT_QUERY")).status, "done");
        assert.ok(requests[0]!.includes("UNNOTIFIED_SUMMARY"));
        assert.ok(!requests[0]!.includes("UNNOTIFIED_RAW"));
    } finally {
        unsubscribe?.();
        await app.close();
    }
});

test("restart resumes the required-frontier wait with one owner and pinned source, not a raw-tail request", async () => {
    let release!: () => void;
    let releaseResume!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
        releaseResume = resolve;
    });
    const sources: string[] = [];
    const requests: string[] = [];
    const data = join(root, "stable-wait-recovery");
    let app = await openApp(
        scriptedModel(async (request) => {
            if (compactor(request.messages)) {
                sources.push(JSON.stringify(request.messages));
                await held;

                return fauxAssistantMessage("interrupted source");
            }

            if (mainRequest(request.messages)) {
                requests.push(JSON.stringify(request.messages));
            }

            return fauxAssistantMessage("answer");
        }),
        data,
    );

    try {
        const id = await seed(app);

        await app.harness.commit(
            (tx) =>
                tx.appendEntry(UserEntry, id, {
                    model: [
                        { role: "user", content: "REQUIRED_ORIGINAL_".repeat(100), timestamp: 1 },
                    ],
                }),
            context,
        );
        await until(() => sources.length === 1, "required source pending");
        const sent = await submit(app, id, "WAIT_RECOVER_CURRENT");

        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 0);
        const before = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;
        const closing = app.close();

        release();
        await closing;
        app = await openApp(
            scriptedModel(async (request) => {
                if (compactor(request.messages)) {
                    sources.push(JSON.stringify(request.messages));
                    await resumed;

                    return fauxAssistantMessage("RECOVERED_REQUIRED_SUMMARY");
                }

                if (mainRequest(request.messages)) {
                    requests.push(JSON.stringify(request.messages));
                }

                return fauxAssistantMessage("RECOVERED_DONE");
            }),
            data,
        );
        await until(() => sources.length === 2, "source recovery admitted");
        assert.equal(sources[0], sources[1]);
        assert.equal(requests.length, 0);
        assert.equal(
            (await app.harness.snapshot(TreeMemoryDoc, id, context))!.worker,
            before.worker,
        );
        releaseResume();
        const receipt = await (await app.harness.submission(sent.submissionId, context))!.wait(
            context,
        );

        assert.equal(receipt.status, "done", JSON.stringify(receipt));
        assert.equal(requests.length, 1);
        assert.ok(requests[0]!.includes("RECOVERED_REQUIRED_SUMMARY"));
        assert.ok(!requests[0]!.includes("REQUIRED_ORIGINAL_"));
        await drained(app, id);
    } finally {
        release();
        releaseResume();
        await app.close();
    }
});

test("restart preserves pending parent source, one durable owner and exact frozen summary-only native request", async () => {
    let releaseParent!: () => void;
    let releaseMain!: () => void;
    let releaseResume!: () => void;
    const parentHeld = new Promise<void>((resolve) => {
        releaseParent = resolve;
    });
    const mainHeld = new Promise<void>((resolve) => {
        releaseMain = resolve;
    });
    const resumeHeld = new Promise<void>((resolve) => {
        releaseResume = resolve;
    });
    const sources: string[] = [];
    const requests: string[] = [];
    let parentEntered = false;
    let mainEntered = false;
    const data = join(root, "stable-frozen-recovery");
    let app = await openApp(
        scriptedModel(async (request) => {
            const text = JSON.stringify(request.messages);

            if (compactor(request.messages)) {
                if (parentRequest(request.messages)) {
                    sources.push(text);
                    parentEntered = true;
                    await parentHeld;

                    return fauxAssistantMessage("interrupted parent");
                }

                return fauxAssistantMessage("LEAF_READY_" + "s".repeat(460));
            }

            if (mainRequest(request.messages)) {
                requests.push(text);
                mainEntered = true;
                await mainHeld;
            }

            return fauxAssistantMessage("answer");
        }),
        data,
    );

    try {
        const id = await seed(app, "old_".repeat(100));

        await app.harness.commit(
            (tx) =>
                tx.appendEntry(UserEntry, id, {
                    model: [
                        { role: "user", content: "REPLAY_ORIGINAL_".repeat(100), timestamp: 1 },
                    ],
                }),
            context,
        );
        await until(() => parentEntered, "parent pending before user input");
        const sent = await submit(app, id, "SUMMARY_RECOVER_CURRENT");

        await until(() => mainEntered, "actual summary-only native request held");
        const before = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;
        const closing = app.close();

        releaseMain();
        releaseParent();
        await closing;
        app = await openApp(
            scriptedModel(async (request) => {
                const text = JSON.stringify(request.messages);

                if (compactor(request.messages)) {
                    sources.push(text);
                    await resumeHeld;

                    return fauxAssistantMessage("recovered parent");
                }

                if (mainRequest(request.messages)) {
                    requests.push(text);
                }

                return fauxAssistantMessage("RECOVERED_DONE");
            }),
            data,
        );
        const receipt = await (await app.harness.submission(sent.submissionId, context))!.wait(
            context,
        );

        assert.equal(receipt.status, "done", JSON.stringify(receipt));
        await until(() => sources.length === 2, "same parent source resumed");
        assert.equal(sources[0], sources[1]);
        assert.equal(requests.length, 2);
        assert.equal(requests[0], requests[1]);
        assert.ok(!requests[1]!.includes("REPLAY_ORIGINAL_"));
        const recovered = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;

        assert.equal(recovered.worker, before.worker);
        assert.equal(recovered.turn!.frozen, before.turn!.frozen);
        assert.notEqual(
            (await app.harness.getTask(before.worker!, context))!.state.status,
            "terminal",
        );
        releaseResume();
        await drained(app, id);
    } finally {
        releaseMain();
        releaseParent();
        releaseResume();
        await app.close();
    }
});

test("saved main view batches 128→64 KB; built parents do not replace individual rows below threshold", async () => {
    const frames: { appended: number; bytes: number; parents: boolean }[] = [];
    const app = await openApp(
        scriptedModel((request) =>
            fauxAssistantMessage(compactor(request.messages) ? "p".repeat(300) : "answer"),
        ),
        join(root, "stable-sawtooth"),
    );
    let unsubscribe: (() => void) | undefined;

    try {
        const id = await seed(app);
        const leaves: Ref[] = [];
        const parents: Ref[] = [];

        await app.harness.commit(async (tx) => {
            for (let i = 0; i < 240; i++) {
                const entry = await tx.appendEntry(UserEntry, id, {
                    model: [{ role: "user", content: "original_".repeat(80), timestamp: i }],
                });
                const text = "s".repeat(500);

                leaves.push({ id: i, n: 1, text });
                Object.assign(await tx.doc(TreeNodeDoc, id, `${i}+1`, {}), {
                    entry: entry.id,
                    part: 0,
                    start: 0,
                    end: evidence(entry.model![0]!).length,
                    text,
                });
                (await tx.doc(TreeMemoryDoc, id)).cursor = entry.id;
            }

            for (let n = 2; n <= 128; n *= 2) {
                for (let start = 0; start + n <= 240; start += n) {
                    (await tx.doc(TreeNodeDoc, id, `${start}+${n}`, {})).text = "p".repeat(300);
                }
            }

            for (const [start, n] of [
                [0, 128],
                [128, 64],
                [192, 32],
                [224, 16],
            ]) {
                parents.push({ id: start!, n: n!, text: "p".repeat(300) });
            }

            Object.assign(await tx.doc(TreeMemoryDoc, id), {
                count: 240,
                appended: 240,
                main: leaves,
                compactor: parents,
            });
        }, context);
        unsubscribe = app.harness.subscribeCommits((publication) => {
            for (const change of publication.changes) {
                if (
                    change.type === "document" &&
                    change.record.kind === TreeMemoryDoc.definition.kind &&
                    change.conversationId === id &&
                    change.value !== null
                ) {
                    const state = change.value as unknown as { main: Ref[]; appended: number };

                    frames.push({
                        appended: state.appended,
                        bytes: bytes(renderView(state.main)),
                        parents: state.main.some((ref) => ref.n > 1),
                    });
                }
            }
        });
        await app.harness.commit(async (tx) => {
            for (let i = 0; i < 20; i++) {
                await tx.appendEntry(UserEntry, id, {
                    model: [{ role: "user", content: "u".repeat(494), timestamp: 250 + i }],
                });
            }
        }, context);
        await drained(app, id);
        const state = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;

        assert.equal(state.count, 260);
        assert.equal(state.mainBatch, false);
        const firstBatch = frames.find((frame) => frame.parents)!;
        const allLeaves = [
            ...leaves,
            ...Array.from({ length: 20 }, (_, i) => ({
                id: 240 + i,
                n: 1,
                text: "user: " + "u".repeat(494),
            })),
        ];

        assert.ok(firstBatch, "batch persisted parent substitutions");
        assert.ok(
            bytes(renderView(allLeaves.slice(0, firstBatch.appended))) > 128000,
            "no substitution until the appended leaf view crosses 128 KB",
        );
        assert.ok(
            frames.some((frame) => frame.parents && frame.bytes <= 64000),
            "size-triggered batch reaches the saved 64 KB target",
        );
        assert.ok(
            bytes(renderView(state.main)) <= 68000,
            "only subsequent appends follow the completed batch",
        );
        assert.ok(bytes(renderView(state.compactor)) <= 32000);
        assert.equal((await ask(app, id, "BATCH_QUERY")).status, "done");
    } finally {
        unsubscribe?.();
        await app.close();
    }
});

test("final native beforeRequest hooks cannot dispatch an overbudget saved-view request", async () => {
    const requests: string[] = [];
    const provider = scriptedModel((request) => {
        if (mainRequest(request.messages)) {
            requests.push(JSON.stringify(request.messages));
        }

        return fauxAssistantMessage("answer");
    });

    provider.models[0].contextWindow = 32768;
    const app = await openApp(provider, join(root, "stable-hook-budget"));

    app.settings.applyOverrides({ compaction: { reserveTokens: 1000 } });

    try {
        const id = await seed(app);

        writeFileSync(
            join(app.dataDir, "extensions/overflow.ts"),
            `/** Synthetic request-budget regression. */
import { defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";
export default () => defineExtension({ name: "overflow", hooks: [hook(GenerationTask, {
    beforeRequest: ({ messages }) => ({ messages: [...messages, { role: "user", content: "HOOK_OVERFLOW_".repeat(16000), timestamp: 0 }] }),
})] });`,
        );
        await app.setExtensionEnabled(owner(app), "overflow.ts", true);
        const receipt = await ask(app, id, "HOOK_CURRENT_QUERY");

        assert.equal(receipt.status, "unanswered", JSON.stringify(receipt));
        assert.ok(
            "detail" in receipt &&
                String(receipt.detail).includes("provider request exceeds bounded"),
        );
        assert.equal(requests.length, 0);
    } finally {
        await app.close();
    }
});

for (const action of ["reset", "disable"] as const) {
    test(`steady background ${action} rejects late completion and settles its durable owner`, async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered = false;
        const app = await openApp(
            scriptedModel(async (request) => {
                if (compactor(request.messages)) {
                    entered = true;
                    await held;

                    return fauxAssistantMessage("STALE_BACKGROUND_RESULT");
                }

                return fauxAssistantMessage("answer");
            }),
            join(root, `stable-${action}`),
        );

        try {
            const id = await seed(app);

            await app.harness.commit(
                (tx) =>
                    tx.appendEntry(UserEntry, id, {
                        model: [{ role: "user", content: "old_source_".repeat(200), timestamp: 1 }],
                    }),
                context,
            );
            await until(() => entered, "steady job held");
            const before = (await app.harness.snapshot(TreeMemoryDoc, id, context))!;

            if (action === "reset") {
                await app.harness.commit(
                    (tx) => tx.appendEntry(ResetEntry, id, { model: [] }),
                    context,
                );
                await until(
                    async () =>
                        (await app.harness.snapshot(TreeMemoryDoc, id, context))!.count === 0,
                    "epoch advanced",
                );
                assert.equal(
                    (await app.harness.snapshot(TreeMemoryDoc, id, context))!.worker,
                    undefined,
                );
                release();
            } else {
                const disabled = app.treeMemory.set(
                    id,
                    false,
                    undefined,
                    false,
                    context,
                    owner(app),
                );

                await until(
                    async () => !(await app.harness.snapshot(TreeMemoryDoc, id, context))!.enabled,
                    "disabled",
                );
                release();
                await disabled;
            }

            await app.harness.waitForTask(before.worker!, context);
            assert.equal(
                (
                    await app.harness.snapshot(
                        TreeNodeDoc,
                        id,
                        nodeKey({ id: 1, n: 1 }, before.resetBoundary ?? 0),
                        context,
                    )
                )?.text,
                undefined,
            );
        } finally {
            release();
            await app.close();
        }
    });
}
