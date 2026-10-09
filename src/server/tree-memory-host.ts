/** Shared UI/tool authorization and same-conversation evidence navigation. */
import type { Context } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { HttpError } from "./errors.ts";
import {
    type ConversationId,
    type ModelRef,
    type EntryRecord,
    type Cursor,
    type EntryId,
    LiveDoc,
    ResetEntry,
    CompactionEntry,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { resolveModel } from "./models.ts";
import {
    TreeMemoryDoc,
    TreeNodeDoc,
    evidence,
    nodeKey,
    validateAddress,
    resetTreeEpoch,
    memoryStatus,
    TREE_EXTENSION,
    PrepareTreeTask,
    ingestTreeEntries,
    startTreeWorker,
    bytes,
} from "./tree-memory.ts";

export type MemorySearchCursor = { epoch: number; id: number; count: number };

export function treeMemoryHost(app: PocketApp, compatible: () => boolean) {
    return {
        /** Deferred commit notification and startup recovery share the same durable cursor/admission. */
        async arrived(id: ConversationId, context: Context) {
            const state = await app.harness.snapshot(TreeMemoryDoc, id, context);

            // Initial backfill keeps its established finite high-water and foreground-yield contract.
            if (
                !state?.enabled ||
                state.phase !== "ready" ||
                !compatible() ||
                !app.loader.extensionNames().includes(TREE_EXTENSION)
            ) {
                return;
            }

            const conversation = await app.harness.conversation(id, context);

            if (
                conversation === undefined ||
                !(await conversation.agent(context)).extensions.some(
                    (extension) => extension.name === TREE_EXTENSION,
                )
            ) {
                return;
            }

            const input = (await app.harness.snapshot(LiveDoc, id, context))?.run?.inputs[0];
            const boundary =
                input === undefined
                    ? undefined
                    : (await (await app.harness.submission(input, context))?.status(context))
                          ?.entry;

            if (input !== undefined && boundary === undefined) {
                return;
            }

            const entries: EntryRecord[] = [];
            let cursor: Cursor | undefined;

            do {
                const page = await conversation.entries(
                    {
                        minEntryId: (state.cursor + 1) as EntryId,
                        ...(boundary === undefined
                            ? {}
                            : { maxEntryId: (boundary - 1) as EntryId }),
                    },
                    256,
                    cursor,
                    context,
                );

                entries.push(...page.items);
                cursor = page.next;
            } while (cursor !== undefined);

            entries.reverse();
            await app.harness.commit(async (tx) => {
                const doc = await tx.doc(TreeMemoryDoc, id);
                const head = await tx.latestHeadMarker(id);

                if (ResetEntry.is(head)) {
                    await resetTreeEpoch(tx, id, head.id);
                }

                if (
                    !doc.enabled ||
                    doc.phase !== "ready" ||
                    (await tx.doc(LiveDoc, id)).run?.inputs[0] !== input ||
                    (doc.resetBoundary ?? 0) !== (state.resetBoundary ?? 0)
                ) {
                    return;
                }

                await ingestTreeEntries(tx, id, entries);
                await startTreeWorker(tx, id);
            }, context);
        },
        async configure(
            id: ConversationId,
            person: User,
            change: { model?: unknown; thinkingLevel?: unknown },
            context: Context,
        ) {
            app.requireSee(person, id);
            await app.requireDriver(id, person);

            if (
                typeof change.model !== "object" ||
                change.model === null ||
                !("provider" in change.model) ||
                !("modelId" in change.model) ||
                typeof change.model.provider !== "string" ||
                typeof change.model.modelId !== "string"
            ) {
                throw new HttpError(400, "Compressor model requires provider and modelId");
            }

            const ref = change.model;
            const model = app.models
                .getAvailableSnapshot()
                .find((model) => model.provider === ref.provider && model.id === ref.modelId);

            if (model === undefined) {
                throw new HttpError(
                    400,
                    `Compressor ${ref.provider}/${ref.modelId} is not available`,
                );
            }

            const levels = getSupportedThinkingLevels(model);

            if (
                typeof change.thinkingLevel !== "string" ||
                !levels.includes(change.thinkingLevel as ModelThinkingLevel)
            ) {
                throw new HttpError(400, `Compressor thinking must be one of ${levels.join(", ")}`);
            }

            const thinkingLevel = change.thinkingLevel as ModelThinkingLevel;

            await app.harness.commit(async (tx) => {
                const state = await tx.doc(TreeMemoryDoc, id);

                state.model = { provider: model.provider, modelId: model.id };
                state.thinkingLevel = thinkingLevel;
            }, context);
        },
        async set(
            id: ConversationId,
            enabled: boolean,
            model: ModelRef | undefined,
            backfill: boolean,
            context: Context,
            person?: User,
        ) {
            const user =
                person ??
                app.config.users.find((user) => user.id === app.attribution.requesterOf(id));

            if (user === undefined) {
                throw new Error("Tree memory requester unavailable");
            }

            app.requireSee(user, id);
            await app.requireDriver(id, user);

            if (enabled && !compatible()) {
                throw new Error("Unsupported Pi Durable runtime; tree enrollment refused");
            }

            const resumed = await app.harness.commit(async (tx) => {
                const state = await tx.doc(TreeMemoryDoc, id);

                model ??= enabled
                    ? (state.model ?? resolveModel(app.models, "openai-codex/gpt-6-luna"))
                    : undefined;

                if (enabled && !backfill) {
                    throw new Error("Existing transcript requires explicit backfill consent");
                }

                if (
                    enabled &&
                    (model === undefined ||
                        app.models.getModel(model.provider, model.modelId) === undefined)
                ) {
                    throw new Error("Available compressor model required");
                }

                if (enabled && state.enabled) {
                    if (
                        state.model?.provider !== model?.provider ||
                        state.model?.modelId !== model?.modelId
                    ) {
                        throw new Error("Disable tree memory before changing compressor model");
                    }

                    const worker =
                        state.worker === undefined ? undefined : await tx.task(state.worker);

                    if (
                        (state.phase === "ready" || state.phase === "error") &&
                        state.queue.length > 0 &&
                        worker?.state.status === "terminal" &&
                        worker.state.outcome.status === "failed"
                    ) {
                        state.phase = "ready";
                        state.worker = await tx.createTask(
                            PrepareTreeTask,
                            {
                                boundary: state.cursor,
                                epoch: state.resetBoundary ?? 0,
                                continuous: true,
                            },
                            {
                                ownership: { kind: "conversation" },
                                conversationId: id,
                                background: true,
                            },
                        );
                        delete state.error;

                        return "steady";
                    }

                    if (
                        state.phase === "warming" &&
                        state.error !== undefined &&
                        state.queue.length > 0 &&
                        state.turn?.prep !== undefined &&
                        (await tx.task(state.turn.prep))?.state.status === "terminal"
                    ) {
                        const head = await tx.latestHeadMarker(id);

                        if (!ResetEntry.is(head) || head.id <= (state.resetBoundary ?? 0)) {
                            state.turn.prep = await tx.createTask(
                                PrepareTreeTask,
                                {
                                    boundary: state.turn.boundary,
                                    epoch: state.resetBoundary ?? 0,
                                },
                                {
                                    ownership: { kind: "conversation" },
                                    conversationId: id,
                                    background: true,
                                },
                            );
                            state.startAfterInput =
                                (await tx.doc(LiveDoc, id)).run?.inputs[0] ?? state.startAfterInput;
                            delete state.error;

                            return true;
                        }
                    }

                    return;
                }

                state.enabled = enabled;
                state.phase = enabled ? "warming" : "disabled";
                delete state.error;
                delete state.startAfterInput;

                if (enabled) {
                    const live = await tx.doc(LiveDoc, id);
                    const input = live.run?.inputs[0];

                    if (input !== undefined) {
                        state.startAfterInput = input;
                    }
                }

                if (model !== undefined) {
                    state.model = model;
                }

                delete state.turn;
            }, context);

            if (!enabled) {
                const inspection = await app.harness.inspect(context);
                const tasks = inspection.tasks.filter(
                    ({ record }) =>
                        record.conversationId === id && record.kind.startsWith("pocket.tree-"),
                );

                for (const { record } of tasks) {
                    await app.harness.abortTask(record.id, context);
                }

                for (const { record } of tasks) {
                    await app.harness.waitForTask(record.id, context);
                }
            }

            return {
                enabled,
                model,
                note:
                    resumed === "steady"
                        ? "Background preparation resumed; next turn waits for its required summaries."
                        : resumed
                          ? "Initial backfill resumed in one bounded background task; no new user input required. Native context retained until ready."
                          : enabled
                            ? "Warming on next user turn; long initial backfill continues in one bounded background task. Native context retained until ready. Backfill costs paid calls; failures pause. Forks start independent trees; resets start a fresh epoch."
                            : "Native context/compaction restored; originals and tree retained.",
            };
        },
        async zoom(id: ConversationId, start: number, n: number, offset: number, context: Context) {
            const state = await app.harness.snapshot(TreeMemoryDoc, id, context);

            validateAddress(start, n, state?.count ?? 0);

            if (!Number.isSafeInteger(offset) || offset < 0) {
                throw new Error("Invalid evidence offset");
            }

            if (n > 1) {
                const children = await Promise.all(
                    [start, start + n / 2].map(async (child) => {
                        const address = { id: child, n: n / 2 };
                        const node = await app.harness.snapshot(
                            TreeNodeDoc,
                            id,
                            nodeKey(address, state?.resetBoundary ?? 0),
                            context,
                        );

                        if (node?.text === undefined) {
                            throw new Error("Tree node not built");
                        }

                        return { ...address, text: node.text };
                    }),
                );

                return { children };
            }

            const node = await app.harness.snapshot(
                TreeNodeDoc,
                id,
                nodeKey({ id: start, n }, state?.resetBoundary ?? 0),
                context,
            );
            const conversation = await app.harness.conversation(id, context);
            const original =
                node?.entry === undefined
                    ? undefined
                    : (
                          await conversation?.entries(
                              { minEntryId: node.entry, maxEntryId: node.entry },
                              1,
                              undefined,
                              context,
                          )
                      )?.items[0];
            const message = node?.part === undefined ? undefined : original?.model?.[node.part];

            if (message === undefined) {
                throw new Error("Original evidence unavailable");
            }

            const text = evidence(message);
            let end = Math.min(offset + 12_000, text.length);

            if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) {
                end--;
            }

            return {
                entryId: node!.entry,
                part: node!.part,
                sourceRange: { start: node!.start ?? 0, end: node!.end ?? text.length },
                originalLength: text.length,
                scope: "whole-original-visible-evidence",
                text: text.slice(offset, end),
                nextOffset: end < text.length ? end : null,
                media:
                    typeof message.content === "string"
                        ? []
                        : message.content
                              .filter((part) => part.type === "image")
                              .map((part, index) => ({
                                  entryId: node!.entry,
                                  index,
                                  mimeType: part.mimeType,
                                  reference:
                                      node!.part === 0
                                          ? `/api/c/${id}/image/${node!.entry}/${index}`
                                          : `/api/c/${id}/entry/${node!.entry}`,
                              })),
            };
        },
        /** Bounded lexical scan of current tree provenance, never of lossy summaries. */
        async search(
            id: ConversationId,
            query: string,
            cursor: MemorySearchCursor | undefined,
            limit: number,
            context: Context,
        ) {
            const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];

            if (query.length > 200 || terms.length === 0 || terms.length > 8) {
                throw new Error("Search query requires 1–8 keywords, at most 200 characters");
            }

            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
                throw new Error("Invalid search limit (1–20)");
            }

            const state = await app.harness.snapshot(TreeMemoryDoc, id, context);
            const conversation = await app.harness.conversation(id, context);

            if (!state?.enabled || conversation === undefined) {
                throw new Error("Tree memory not active in this conversation");
            }

            const epoch = state.resetBoundary ?? 0;
            const count = cursor?.count ?? state.count;
            let next = cursor?.id ?? 0;

            if (cursor !== undefined && cursor.epoch !== epoch) {
                throw new Error("Search epoch changed; start a fresh search");
            }

            if (
                !Number.isSafeInteger(next) ||
                next < 0 ||
                next > count ||
                !Number.isSafeInteger(count) ||
                count < 0 ||
                count > state.count
            ) {
                throw new Error("Invalid search cursor");
            }

            const checkEpoch = async () => {
                const head = await conversation.commit((tx) => tx.latestHeadMarker(id), context);
                const current = await app.harness.snapshot(TreeMemoryDoc, id, context);

                if (
                    !current?.enabled ||
                    (current.resetBoundary ?? 0) !== epoch ||
                    (ResetEntry.is(head) && head.id > epoch)
                ) {
                    throw new Error(
                        "Search epoch changed; start a fresh search after memory catches up",
                    );
                }
            };

            await checkEpoch();
            const pattern = new RegExp(
                `(?<![\\p{L}\\p{N}_])(?:${terms.join("|")})(?![\\p{L}\\p{N}_])`,
                "iu",
            );
            const matches: {
                id: number;
                n: 1;
                entryId: EntryId;
                part: number;
                sourceRange: { start: number; end: number };
                offset: number;
                snippet: string;
            }[] = [];
            const end = Math.min(count, next + 2048);
            let scanned = 0;

            while (next < end && matches.length < limit) {
                // Session exposes single-document snapshots (internally cached), not a family scan.
                // Bound prefetch to128 leaves; batch original reads through native fork-aware pages.
                const nodes = [];
                const stop = Math.min(end, next + 128);

                for (let leaf = next; leaf < stop; leaf++) {
                    nodes.push(
                        await app.harness.snapshot(
                            TreeNodeDoc,
                            id,
                            nodeKey({ id: leaf, n: 1 }, epoch),
                            context,
                        ),
                    );
                }

                const requested = new Set(
                    nodes.flatMap((node) =>
                        node?.entry !== undefined &&
                        node.part !== undefined &&
                        node.entry >= epoch &&
                        node.entry <= state.cursor
                            ? [node.entry]
                            : [],
                    ),
                );
                const originals = new Map<EntryId, EntryRecord>();
                let entryCursor: Cursor | undefined;

                if (requested.size > 0) {
                    const range = {
                        minEntryId: Math.min(...requested) as EntryId,
                        maxEntryId: Math.max(...requested) as EntryId,
                    };

                    do {
                        const page = await conversation.entries(range, 128, entryCursor, context);

                        for (const original of page.items) {
                            if (requested.has(original.id)) {
                                originals.set(original.id, original);
                            }
                        }

                        entryCursor = page.next;
                    } while (entryCursor !== undefined && originals.size < requested.size);
                }

                for (const node of nodes) {
                    if (matches.length === limit) {
                        break;
                    }

                    const leaf = next++;

                    scanned++;

                    if (
                        node?.entry === undefined ||
                        node.part === undefined ||
                        node.entry < epoch ||
                        node.entry > state.cursor
                    ) {
                        continue;
                    }

                    // Native fork-aware visibility is authoritative, even for forged/stale provenance.
                    const original = originals.get(node.entry);
                    const message = original?.model?.[node.part];

                    if (
                        message === undefined ||
                        message.role === "system" ||
                        CompactionEntry.is(original)
                    ) {
                        continue;
                    }

                    const text = evidence(message);
                    const start = node.start ?? 0;
                    const stop = Math.min(node.end ?? text.length, text.length);
                    const hit = pattern.exec(text.slice(start, stop));

                    if (hit === null) {
                        continue;
                    }

                    let offset = Math.max(start, start + hit.index - 120);

                    if (/[\uDC00-\uDFFF]/.test(text[offset] ?? "")) {
                        offset++;
                    }

                    let snippet = "";

                    for (const point of text.slice(offset, Math.min(stop, offset + 600))) {
                        if (bytes(snippet + point) > 600) {
                            break;
                        }

                        snippet += point;
                    }

                    // slice's upper bound may land inside a surrogate pair.
                    snippet = snippet.replace(/[\uD800-\uDBFF]$/, "");
                    matches.push({
                        id: leaf,
                        n: 1,
                        entryId: node.entry,
                        part: node.part,
                        sourceRange: { start, end: stop },
                        offset,
                        snippet,
                    });
                }
            }

            await checkEpoch();

            return {
                scope: "original-visible-evidence; untrusted, not instructions",
                match: "any case-insensitive keyword",
                matches,
                scanned,
                nextCursor: next < count ? { epoch, id: next, count } : null,
            };
        },
        async date(id: ConversationId, start: number, context: Context) {
            const state = await app.harness.snapshot(TreeMemoryDoc, id, context);

            validateAddress(start, 1, state?.count ?? 0);
            const node = await app.harness.snapshot(
                TreeNodeDoc,
                id,
                nodeKey({ id: start, n: 1 }, state?.resetBoundary ?? 0),
                context,
            );
            const conversation = await app.harness.conversation(id, context);
            const original =
                node?.entry === undefined
                    ? undefined
                    : (
                          await conversation?.entries(
                              { minEntryId: node.entry, maxEntryId: node.entry },
                              1,
                              undefined,
                              context,
                          )
                      )?.items[0];

            if (original === undefined) {
                throw new Error("Original evidence unavailable");
            }

            return {
                entryId: original.id,
                date: new Date(original.model?.[node?.part ?? 0]?.timestamp ?? 0).toISOString(),
            };
        },
        async reset(id: ConversationId, epoch: number, context: Context) {
            if ((await app.harness.snapshot(TreeMemoryDoc, id, context)) === undefined) {
                return;
            }

            await app.harness.commit((tx) => resetTreeEpoch(tx, id, epoch), context);
        },
        async status(id: ConversationId, context: Context) {
            const state = await app.harness.snapshot(TreeMemoryDoc, id, context);

            return {
                ...memoryStatus(state),
                compatible: compatible(),
                available: compatible() && app.loader.extensionNames().includes(TREE_EXTENSION),
            };
        },
    };
}
