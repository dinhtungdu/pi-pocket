/** Shared requester-scoped session operations and durable completion reports. */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantEntry,
    UserEntry,
    defineTask,
    type AgentChange,
    type ConversationId,
    type EntryId,
    type SubmissionId,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { SessionMessagesDoc, SessionReceiptsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { requestFor } from "./requests.ts";
import { projectEntry } from "./projection.ts";

const context = BACKGROUND_CONTEXT;
const MAX_MESSAGE = 20_000;
const MAX_REPORT = 12_000;

export type SessionMessage = {
    target: ConversationId;
    text: string;
    mode: "steer" | "followUp";
    key: string;
};

// Keep the persisted field/task contract: ownerId binds the actual requester.
type ReportInput = SessionMessage & { ownerId: string };
type ReportState = { phase: "deliver" } | { phase: "report"; text: string; answer?: EntryId };

export class Sessions {
    readonly #app: PocketApp;
    readonly task;

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<ReportInput, ReportState, null>({
            name: "pocket.chief-report",
            version: 1,
            initial: () => ({ phase: "deliver" }),
            phases: {
                deliver: async (reporter, runtime, taskContext) => {
                    const input = reporter.input;
                    let text: string;
                    let answerId: EntryId | undefined;

                    try {
                        const requestId = requestFor(
                            input.ownerId,
                            `chief-${this.#hash(input.key)}`,
                        );
                        // Admission may have committed before a crash. Wait for that exact submission without
                        // rechecking changed spend/turn settings or admitting another message.
                        const existing = await app.harness.commit(
                            (tx) => tx.submissionByRequest(input.target, requestId),
                            taskContext,
                        );
                        let submissionId: SubmissionId;

                        if (existing !== undefined) {
                            submissionId = existing.id;
                        } else {
                            const owner = app.config.userById(input.ownerId);

                            if (owner === undefined) {
                                throw new Error("The message requester no longer exists.");
                            }

                            app.requireSee(owner, runtime.conversationId);

                            this.#target(owner, input.target);
                            const submitted = await app.commands.submit(
                                input.target,
                                owner,
                                {
                                    text: `[Session ${runtime.conversationId}, for ${owner.name}] ${input.text}`,
                                    mode: input.mode,
                                    requestId: input.key,
                                },
                                requestId,
                            );

                            submissionId = submitted.submissionId;
                        }

                        const submission = (await app.harness.submission(
                            submissionId,
                            taskContext,
                        ))!;
                        const settled = await submission.wait(taskContext);

                        if (settled.status === "unanswered") {
                            text = `failed: ${settled.reason}`;
                        } else if (settled.type === "input") {
                            const answer = await app.harness.commit(
                                (tx) => tx.entry(AssistantEntry, settled.answer),
                                taskContext,
                            );

                            const message = answer?.model?.[0] as AssistantMessage | undefined;

                            text = (message?.content ?? [])
                                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                                .join("");
                            answerId = settled.answer;
                        } else {
                            text = "finished without an answer";
                        }
                    } catch (error) {
                        text = `failed: ${error instanceof Error ? error.message : String(error)}`;
                    }

                    await runtime.commit(
                        () => ({
                            status: "running",
                            checkpoint: {
                                phase: "report",
                                text: text.slice(0, MAX_REPORT),
                                ...(answerId === undefined ? {} : { answer: answerId }),
                            },
                        }),
                        taskContext,
                    );
                },
                report: async (reporter, runtime, taskContext) => {
                    const content = `[Session report from session ${reporter.input.target}; no reply needed] ${reporter.state.checkpoint.text}\n\nOpen session: /s/${reporter.input.target}`;
                    const checkpoint = reporter.state.checkpoint;
                    // Old checkpoints contain only text. Recover completion identity from their durable input receipt.
                    const answer =
                        checkpoint.answer ??
                        (await app.harness.commit(async (tx) => {
                            const submitted = await tx.submissionByRequest(
                                reporter.input.target,
                                requestFor(
                                    reporter.input.ownerId,
                                    `chief-${this.#hash(reporter.input.key)}`,
                                ),
                            );

                            return submitted?.type === "input" && submitted.status === "done"
                                ? submitted.answer
                                : undefined;
                        }, taskContext));
                    // Native request IDs are source-scoped and atomically admitted: concurrent reporters of one
                    // answer converge, while failures and distinct answers (even identical text) remain separate.
                    const requestId =
                        answer === undefined
                            ? `chief-report:${reporter.id}`
                            : `chief-report-answer:${reporter.input.target}:${answer}`;
                    const legacyRequestId = requestFor(
                        reporter.input.ownerId,
                        `chief-report-${reporter.id}`,
                    );
                    const existing = await app.harness.commit(
                        async (tx) =>
                            (await tx.submissionByRequest(runtime.conversationId, requestId)) ??
                            (await tx.submissionByRequest(
                                runtime.conversationId,
                                `chief-report:${reporter.id}`,
                            )) ??
                            (await tx.submissionByRequest(runtime.conversationId, legacyRequestId)),
                        taskContext,
                    );

                    // Reports are passive user entries in the originating conversation, never new model work.
                    // The report prefix lets the renderer provide an Open link without waking the model.
                    if (existing === undefined) {
                        await (
                            await app.conversation(runtime.conversationId)
                        ).submit(
                            {
                                type: "write",
                                entry: {
                                    kind: UserEntry.kind,
                                    model: [
                                        {
                                            role: "user",
                                            content: [{ type: "text", text: content }],
                                            timestamp: Date.now(),
                                        },
                                    ],
                                },
                                requestId,
                            },
                            taskContext,
                        );
                    }

                    await runtime.commit(
                        () => ({
                            status: "terminal",
                            outcome: { status: "completed", result: null },
                        }),
                        taskContext,
                    );
                },
            },
            abort: (_reporter, runtime, taskContext) =>
                runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "aborted" } }),
                    taskContext,
                ),
        });
    }

    #hash(key: string): string {
        return createHash("sha256").update(key).digest("hex");
    }

    #requesterFor(source: ConversationId): User {
        const id = this.#app.attribution.requesterOf(source);
        const user = id === undefined ? undefined : this.#app.config.userById(id);

        if (user === undefined) {
            throw new HttpError(403, "No current requester for this conversation.");
        }

        this.#app.requireSee(user, source);

        return user;
    }

    #target(owner: User, target: ConversationId): void {
        if (this.#app.sessionMeta(target) === undefined) {
            throw new HttpError(404, "No project session with that id.");
        }

        this.#app.requireSee(owner, target);
    }

    async setArchived(
        source: ConversationId,
        target: ConversationId,
        archived: boolean,
        key: string,
    ) {
        const owner = this.#requesterFor(source);

        this.#target(owner, target);
        await this.#app.commands.updateSession(target, owner, { archived }, key);

        return { sessionId: target, archived };
    }

    /** Same stop as the browser: steering permission, no driver check, native queue semantics. */
    async stop(source: ConversationId, target: ConversationId) {
        const requester = this.#requesterFor(source);

        this.#target(requester, target);
        await this.#app.commands.abort(target, requester);

        return { sessionId: target, stopRequested: true };
    }

    async list(source: ConversationId) {
        const owner = this.#requesterFor(source);

        return this.#app
            .sessions(owner)
            .filter((session) => session.id !== Number(source))
            .map(({ id, title, cwd, busy, archived, waiting }) => ({
                id,
                title,
                cwd,
                busy,
                archived,
                waiting,
            }));
    }

    async read(source: ConversationId, target: ConversationId, before?: number) {
        const owner = this.#requesterFor(source);

        this.#target(owner, target);
        const conversation = await this.#app.conversation(target);
        const page = await conversation.entries(
            before === undefined ? {} : { maxEntryId: (before - 1) as EntryId },
            20,
            undefined,
            context,
        );
        const entries = page.items.flatMap((entry) => {
            const projected = projectEntry(entry);

            if (projected === undefined) {
                return [];
            }

            const data = JSON.stringify(projected);

            return [
                {
                    id: entry.id,
                    kind: projected.kind,
                    data: data.slice(0, 2000),
                    truncated: data.length > 2000,
                },
            ];
        });

        return { entries, before: page.next === undefined ? undefined : page.items.at(-1)?.id };
    }

    async create(
        source: ConversationId,
        request: { cwd: string; title?: string; worktree?: boolean },
        key: string,
        agent: AgentChange,
    ) {
        const owner = this.#requesterFor(source);

        const existing = (await this.#app.harness.snapshot(SessionReceiptsDoc, context))?.creates[
            key
        ];

        if (existing !== undefined) {
            this.#app.requireSee(owner, existing);
            this.#app.requireSteer(owner);

            return { id: existing };
        }

        return this.#app.commands.createSession(owner, request, { key, agent });
    }

    async message(source: ConversationId, request: SessionMessage) {
        const existing = (await this.#app.harness.snapshot(SessionMessagesDoc, source, context))
            ?.items[request.key];

        if (existing !== undefined) {
            return { taskId: existing, sessionId: request.target };
        }

        const owner = this.#requesterFor(source);

        this.#target(owner, request.target);
        await this.#app.requireDriver(request.target, owner);
        this.#app.spend.check(owner, request.target);

        if (request.text.trim() === "" || request.text.length > MAX_MESSAGE) {
            throw new HttpError(400, `Message must contain 1–${MAX_MESSAGE} characters.`);
        }

        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(SessionMessagesDoc, source);
            const existing = doc.items[request.key];

            if (existing !== undefined) {
                return { taskId: existing, sessionId: request.target };
            }

            const taskId = await tx.createTask(
                this.task,
                { ...request, ownerId: owner.id },
                { ownership: { kind: "conversation" }, conversationId: source, background: true },
            );

            doc.items[request.key] = taskId;

            return { taskId, sessionId: request.target };
        }, context);
    }

    async schedules(
        source: ConversationId,
        target: ConversationId,
        action: "schedule-add" | "schedule-list" | "schedule-cancel",
        request: { when?: string; message?: string; id?: string; key: string },
    ) {
        const owner = this.#requesterFor(source);

        this.#target(owner, target);

        if (action === "schedule-list") {
            return this.#app.schedules.list(target);
        }

        await this.#app.requireDriver(target, owner);

        if (action === "schedule-cancel") {
            if (request.id === undefined) {
                throw new HttpError(400, "schedule-cancel needs id.");
            }

            return {
                cancelled: (await this.#app.schedules.cancel(target, request.id)) !== undefined,
            };
        }

        if (request.when === undefined || request.message === undefined) {
            throw new HttpError(400, "schedule-add needs when and message.");
        }

        const existing = (await this.#app.schedules.list(target)).find(
            (item) => item.key === request.key,
        );

        if (existing !== undefined) {
            return existing;
        }

        return this.#app.schedules.add(target, {
            when: request.when,
            text: `[Session ${source}] ${request.message}`,
            requestedBy: owner.id,
            key: request.key,
        });
    }
}
