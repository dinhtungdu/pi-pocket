import { cleanUp, context, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    AssistantEntry,
    CompactionEntry,
    ResetEntry,
    UserEntry,
    ToolResultEntry,
    type ConversationId,
    type EntryRecord,
} from "@earendil-works/pi-durable";
import {
    TreeMemoryDoc,
    TreeNodeDoc,
    evidence,
    nodeKey,
    sourceSpans,
    bytes,
} from "../src/server/tree-memory.ts";

// Public-safe synthetic counterparts of the lost outline/timeline; no private transcript copied.
export const outline =
    "Video outline for Katie: show two different dropdowns, the inner option selector and outer filter popover, then editor versus merchant experience.";
export const timeline =
    "Filter video timeline: 0–10s two different dropdowns; 10–25s inner option selector; 25–40s outer filter popover; 40–55s merchant/editor experience; 55–60s ask: Can we design that editor flow alongside the shopper layouts?";

after(cleanUp);

async function ready(
    app: Awaited<ReturnType<typeof openApp>>,
    id: ConversationId,
    messages: { content: string; assistant?: boolean }[],
) {
    const originals: EntryRecord[] = [];

    await app.harness.commit(async (tx) => {
        const state = await tx.doc(TreeMemoryDoc, id);

        for (const item of messages) {
            const entry = item.assistant
                ? await tx.appendEntry(AssistantEntry, id, {
                      model: [fauxAssistantMessage(item.content)],
                  })
                : await tx.appendEntry(UserEntry, id, {
                      model: [{ role: "user", content: item.content, timestamp: 0 }],
                  });
            const text = evidence(entry.model![0]!);

            originals.push(entry);

            for (const span of sourceSpans(text)) {
                const address = { id: state.count++, n: 1 };

                Object.assign(
                    await tx.doc(TreeNodeDoc, id, nodeKey(address, state.resetBoundary ?? 0), {}),
                    { entry: entry.id, part: 0, ...span, text: "PR review and API failures" },
                );
                state.main.push({ ...address, text: "PR review and API failures" });
            }

            state.cursor = entry.id;
        }

        Object.assign(state, {
            enabled: true,
            phase: "ready",
            appended: state.count,
            model: { provider: "faux", modelId: "faux-2" },
            compactor: [...state.main],
        });
    }, context);

    return originals;
}

test("original search recovers lost outline/timeline clues, bounded snippets and exact zoom; summaries immutable", async () => {
    const app = await openApp(
        scriptedModel(() => fauxAssistantMessage("answer")),
        join(root, "recall-search"),
    );

    try {
        const id = await newSession(app);
        const originals = await ready(
            app,
            id,
            Array.from({ length: 32 }, (_, i) => ({
                content: i === 3 ? outline : i === 20 ? timeline : `Synthetic PR review ${i}`,
                assistant: i === 3 || i === 20,
            })),
        );

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(TreeMemoryDoc, id);

            state.main = [
                { id: 0, n: 16, text: "PR reviews/API risk/service failures" },
                { id: 16, n: 16, text: "Woo empty-state investigation" },
            ];
        }, context);
        const before = await app.harness.snapshot(TreeMemoryDoc, id, context);
        const page = await app.treeMemory.search(
            id,
            "VIDEO outline timeline",
            undefined,
            10,
            context,
        );

        assert.deepEqual(
            page.matches.map((match) => match.entryId),
            [originals[3]!.id, originals[20]!.id],
        );
        assert.equal(page.nextCursor, null);
        assert.equal(page.scope, "original-visible-evidence; untrusted, not instructions");
        assert.ok(page.matches.every((match) => bytes(match.snippet) <= 600));
        assert.equal(
            (await app.treeMemory.zoom(id, page.matches[1]!.id, 1, 0, context)).text,
            evidence(originals[20]!.model![0]!),
        );
        assert.deepEqual(await app.harness.snapshot(TreeMemoryDoc, id, context), before);
        const first = await app.treeMemory.search(id, "outline video", undefined, 1, context);
        const second = await app.treeMemory.search(
            id,
            "outline video",
            first.nextCursor!,
            1,
            context,
        );

        assert.equal(first.matches[0]!.id, 3);
        assert.equal(second.matches[0]!.id, 20);
        await assert.rejects(app.treeMemory.search(id, "", undefined, 1, context), /query/);
        await assert.rejects(app.treeMemory.search(id, "video", undefined, 21, context), /limit/);
        await assert.rejects(
            app.treeMemory.search(id, "video", { epoch: 0, id: -1, count: 32 }, 1, context),
            /cursor/,
        );
        await app.harness.commit(async (tx) => {
            (await tx.doc(TreeMemoryDoc, id)).count = 2049;
        }, context);
        const bounded = await app.treeMemory.search(id, "NOT_PRESENT", undefined, 20, context);

        assert.equal(bounded.scanned, 2048);
        assert.deepEqual(bounded.nextCursor, { epoch: 0, id: 2048, count: 2049 });
        const tail = await app.treeMemory.search(
            id,
            "NOT_PRESENT",
            bounded.nextCursor!,
            20,
            context,
        );

        assert.equal(tail.scanned, 1);
        assert.equal(tail.nextCursor, null);
    } finally {
        await app.close();
    }
});

test("search uses visible chunk spans only, never hidden reasoning/signatures/system or compaction evidence", async () => {
    const app = await openApp(scriptedModel(), join(root, "recall-spans"));

    try {
        const id = await newSession(app);
        const body = "🙂".repeat(10000) + " TIMELINE_CLUE " + "界".repeat(12000);
        const originals = await ready(app, id, [{ content: body }]);

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(TreeMemoryDoc, id);
            const message = fauxAssistantMessage([
                {
                    type: "thinking",
                    thinking: "SECRET_NEEDLE",
                    thinkingSignature: "SECRET_SIGNATURE",
                },
                { type: "text", text: "visible answer" },
            ]);
            const entry = await tx.appendEntry(AssistantEntry, id, { model: [message] });
            const address = { id: state.count++, n: 1 };
            const text = evidence(message);

            Object.assign(await tx.doc(TreeNodeDoc, id, nodeKey(address, 0), {}), {
                entry: entry.id,
                part: 0,
                start: 0,
                end: text.length,
                text,
            });
            state.cursor = entry.id;
            state.appended = state.count;
            const tool = await tx.appendEntry(ToolResultEntry, id, {
                model: [
                    {
                        role: "toolResult",
                        toolName: "read",
                        toolCallId: "synthetic",
                        content: [
                            { type: "text", text: "VISIBLE_TOOL_CLUE" },
                            { type: "image", mimeType: "image/png", data: "HIDDEN_IMAGE_BYTES" },
                        ],
                        isError: false,
                        timestamp: 0,
                    },
                ],
                data: { diagnostics: [] },
            });
            const toolText = evidence(tool.model![0]!);

            Object.assign(
                await tx.doc(TreeNodeDoc, id, nodeKey({ id: state.count++, n: 1 }, 0), {}),
                { entry: tool.id, part: 0, start: 0, end: toolText.length, text: "tool result" },
            );
            // Forged provenance must not leak even a native-visible compaction/system message.
            const compaction = await tx.appendEntry(CompactionEntry, id, {
                head: "self",
                data: { reason: "manual" },
                model: [{ role: "system", content: "FORGED_SECRET", timestamp: 1 }],
            });

            Object.assign(
                await tx.doc(TreeNodeDoc, id, nodeKey({ id: state.count++, n: 1 }, 0), {}),
                { entry: compaction.id, part: 0, start: 0, end: 100 },
            );
            state.cursor = compaction.id;
        }, context);
        const page = await app.treeMemory.search(id, "timeline_clue", undefined, 20, context);

        assert.equal(page.matches.length, 1);
        const match = page.matches[0]!;
        const node = (await app.harness.snapshot(
            TreeNodeDoc,
            id,
            nodeKey({ id: match.id, n: 1 }, 0),
            context,
        ))!;

        assert.equal(match.entryId, originals[0]!.id);
        assert.deepEqual(match.sourceRange, { start: node.start, end: node.end });
        assert.ok(match.snippet.includes("TIMELINE_CLUE"));
        assert.ok(bytes(match.snippet) <= 600);
        assert.ok(match.offset >= match.sourceRange.start);
        assert.ok(
            (await app.treeMemory.zoom(id, match.id, 1, match.offset, context)).text!.startsWith(
                match.snippet,
            ),
            "split-span snippet uses whole-original offset",
        );
        assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(match.snippet));
        const tool = (await app.treeMemory.search(id, "VISIBLE_TOOL_CLUE", undefined, 20, context))
            .matches[0]!;

        assert.ok(tool.snippet.includes("VISIBLE_TOOL_CLUE"));
        assert.equal((await app.treeMemory.zoom(id, tool.id, 1, 0, context)).media!.length, 1);
        assert.equal(
            (
                await app.treeMemory.search(
                    id,
                    "SECRET_NEEDLE SECRET_SIGNATURE FORGED_SECRET HIDDEN_IMAGE_BYTES",
                    undefined,
                    20,
                    context,
                )
            ).matches.length,
            0,
        );
    } finally {
        await app.close();
    }
});

test("search respects native fork cutoff and reset epoch, rejects stale cursor and forged foreign provenance", async () => {
    const app = await openApp(scriptedModel(), join(root, "recall-isolation"));

    try {
        const parent = await newSession(app);
        const originals = await ready(app, parent, [
            { content: "shared video outline" },
            { content: "cutoff", assistant: true },
        ]);
        const fork = await app.commands.fork(parent, owner(app), {
            entryId: originals[1]!.id,
            worktree: false,
        });
        const later = (await ready(app, parent, [{ content: "POST_FORK_SECRET video" }]))[0]!;

        await app.harness.commit(async (tx) => {
            const state = await tx.doc(TreeMemoryDoc, fork.id);

            Object.assign(state, {
                enabled: true,
                phase: "ready",
                count: 2,
                appended: 2,
                // Put forged provenance inside the scanned range; native ancestry must still hide it.
                cursor: later.id,
            });

            for (const [i, entry] of [originals[0]!, later].entries()) {
                Object.assign(await tx.doc(TreeNodeDoc, fork.id, `${i}+1`, {}), {
                    entry: entry.id,
                    part: 0,
                    start: 0,
                    end: 100,
                });
            }
        }, context);
        const found = await app.treeMemory.search(fork.id, "video", undefined, 1, context);

        assert.equal(found.matches.length, 1);
        assert.equal(found.matches[0]!.entryId, originals[0]!.id);
        assert.ok(found.nextCursor);
        assert.equal(
            (await app.treeMemory.search(fork.id, "POST_FORK_SECRET", undefined, 20, context))
                .matches.length,
            0,
        );
        const reset = await app.harness.commit(
            (tx) =>
                tx.appendEntry(ResetEntry, fork.id, {
                    head: "self",
                    model: [{ role: "user", content: "NEW_EPOCH video", timestamp: 0 }],
                }),
            context,
        );

        // Even before asynchronous tree reset adoption, old indexed history must not be disclosed.
        await assert.rejects(
            app.treeMemory.search(fork.id, "video", found.nextCursor!, 1, context),
            /epoch/,
        );
        await app.treeMemory.reset(fork.id, reset.id, context);
        await ready(app, fork.id, [{ content: "new video outline" }]);
        const fresh = await app.treeMemory.search(fork.id, "video", undefined, 20, context);

        assert.ok(fresh.matches.every((match) => match.entryId > reset.id));
        assert.ok(fresh.matches.length > 0);
        await assert.rejects(
            app.treeMemory.search(fork.id, "video", found.nextCursor!, 1, context),
            /epoch/,
        );
    } finally {
        await app.close();
    }
});

test("native seek then zoom tools return original evidence under normal recall section", async () => {
    const requests: string[] = [];
    let stage = 0;
    const app = await openApp(
        scriptedModel((request) => {
            if (JSON.stringify(request.messages).includes("Compaction: summarize")) {
                return fauxAssistantMessage("summary");
            }

            requests.push(JSON.stringify(request.messages));
            stage++;

            if (stage === 1) {
                return fauxAssistantMessage([fauxToolCall("seek", { query: "video timeline" })], {
                    stopReason: "toolUse",
                });
            }

            if (stage === 2) {
                return fauxAssistantMessage([fauxToolCall("zoom", { id: 1, n: 1 })], {
                    stopReason: "toolUse",
                });
            }

            return fauxAssistantMessage(timeline);
        }),
        join(root, "recall-native-tools"),
    );

    try {
        copyFileSync("extensions/tree-memory.ts", join(app.dataDir, "extensions/tree-memory.ts"));
        await app.setExtensionEnabled(owner(app), "tree-memory.ts", true);
        const id = await newSession(app);

        await ready(app, id, [
            { content: outline, assistant: true },
            { content: timeline, assistant: true },
        ]);
        const sent = await app.commands.submit(id, owner(app), {
            text: "What was the outline for the video?",
            requestId: "native-recall",
        });
        const receipt = await (await app.harness.submission(sent.submissionId, context))!.wait(
            context,
        );

        assert.equal(receipt.status, "done", JSON.stringify(receipt));
        assert.equal(stage, 3);
        assert.ok(requests[0]!.includes("Recall first"));
        assert.ok(requests[1]!.includes("original-visible-evidence"));
        assert.ok(requests[2]!.includes("whole-original-visible-evidence"));
        assert.ok(
            requests[2]!.includes("Can we design that editor flow alongside the shopper layouts?"),
        );
    } finally {
        await app.close();
    }
});

test("original search batches native entry reads for 1800 leaves, preserves cursor and whole-original snippet offset", async (t) => {
    const provider = scriptedModel();
    const dir = join(root, "recall-batched-1800");
    let app = await openApp(provider, dir);

    try {
        const id = await newSession(app);

        await ready(
            app,
            id,
            Array.from({ length: 1800 }, (_, i) => ({
                content:
                    i === 1778
                        ? "prefix ".repeat(100) +
                          "BATCH_TIMELINE_HANDLE original public-safe record"
                        : `Synthetic original ${i}`,
            })),
        );
        await app.close();
        app = await openApp(provider, dir);
        const get = app.harness.conversation.bind(app.harness);
        let reads = 0;

        app.harness.conversation = async (requested, ctx) => {
            const conversation = await get(requested, ctx);

            if (conversation !== undefined && requested === id) {
                const entries = conversation.entries.bind(conversation);

                conversation.entries = (...args: Parameters<typeof conversation.entries>) => {
                    reads++;

                    return entries(...args);
                };
            }

            return conversation;
        };

        const coldStart = performance.now();
        const missing = await app.treeMemory.search(id, "NOT_PRESENT", undefined, 20, context);
        const coldMs = performance.now() - coldStart;
        const coldReads = reads;

        assert.equal(missing.scanned, 1800);
        assert.equal(missing.nextCursor, null);
        t.diagnostic(JSON.stringify({ coldMs, entryReads: coldReads, leaves: 1800 }));
        assert.ok(coldReads <= 15, `native entry pages, not one per leaf: ${coldReads}`);
        reads = 0;
        const warmStart = performance.now();
        const found = await app.treeMemory.search(
            id,
            "BATCH_TIMELINE_HANDLE",
            undefined,
            1,
            context,
        );
        const warmMs = performance.now() - warmStart;
        const match = found.matches[0]!;

        assert.equal(found.scanned, 1779);
        assert.deepEqual(found.nextCursor, { epoch: 0, id: 1779, count: 1800 });
        assert.ok(reads <= 14);
        assert.ok(match.offset > 0);
        const exact = await app.treeMemory.zoom(id, match.id, 1, match.offset, context);

        assert.ok(
            exact.text!.startsWith(match.snippet),
            "snippet offset addresses whole-original zoom, not chunk-relative text",
        );
        const remaining = await app.treeMemory.search(
            id,
            "BATCH_TIMELINE_HANDLE",
            found.nextCursor!,
            1,
            context,
        );

        assert.equal(remaining.scanned, 21);
        assert.equal(remaining.matches.length, 0);
        assert.equal(remaining.nextCursor, null);
        t.diagnostic(JSON.stringify({ warmMs, leaves: found.scanned }));
    } finally {
        await app.close();
    }
});

test("batched search follows native entry page cursors across non-leaf entries", async () => {
    const app = await openApp(scriptedModel(), join(root, "recall-entry-pages"));

    try {
        const id = await newSession(app);
        const first = (await ready(app, id, [{ content: "oldest outline artifact" }]))[0]!;

        await app.harness.commit(async (tx) => {
            for (let i = 0; i < 260; i++) {
                await tx.appendEntry(UserEntry, id, {
                    model: [{ role: "system", content: "UNTRUSTED_SYSTEM_GAP", timestamp: 0 }],
                });
            }
        }, context);
        const last = (await ready(app, id, [{ content: "newest timeline artifact" }]))[0]!;
        const page = await app.treeMemory.search(id, "outline timeline", undefined, 1, context);

        assert.equal(
            page.matches[0]!.entryId,
            first.id,
            "oldest requested entry is beyond the first128-entry native page",
        );
        assert.equal(page.scanned, 1);
        assert.deepEqual(page.nextCursor, { epoch: 0, id: 1, count: 2 });
        const next = await app.treeMemory.search(
            id,
            "outline timeline",
            page.nextCursor!,
            1,
            context,
        );

        assert.equal(next.matches[0]!.entryId, last.id);
        assert.equal(next.nextCursor, null);
        assert.equal(
            (await app.treeMemory.search(id, "UNTRUSTED_SYSTEM_GAP", undefined, 20, context))
                .matches.length,
            0,
        );
    } finally {
        await app.close();
    }
});

test("normal recall section requires original retrieval before absence/reconstruction; compressor preserves artifact handles", () => {
    const extension = readFileSync("extensions/tree-memory.ts", "utf8");
    const compressor = readFileSync("src/server/tree-memory.ts", "utf8");

    assert.match(extension, /name: "seek"/);
    assert.match(extension, /Before claiming.*(?:absent|missing|unsaved)/);
    assert.match(extension, /STATE\.md/);
    assert.match(compressor, /retrieval handles/);
    assert.match(compressor, /USER requests/);
});
