import {
    cleanUp,
    context,
    lastText,
    modelTexts,
    openApp as openCoreApp,
    newSession,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
    work,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { after } from "node:test";
import { openApp, test } from "./owner-sessions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    defineExtension,
    type ConversationId,
    type SubmissionId,
} from "@earendil-works/pi-durable";
import {
    SessionMessagesDoc,
    SessionReceiptsDoc,
    TurnsDoc,
    SubagentsDoc,
} from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

const toolModel = () =>
    scriptedModel((request) => {
        const { role, text } = lastText(request as never);
        const at = text.indexOf("tool:");

        if (role !== "toolResult" && at !== -1) {
            return fauxAssistantMessage(
                [fauxToolCall("sessions", JSON.parse(text.slice(at + 5)))],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(`received: ${text}`)]);
    });

async function httpSubmit(
    app: App,
    source: ConversationId,
    text: string,
    token = app.config.ownerToken,
    requestId: string = crypto.randomUUID(),
) {
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };

    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/c/${source}/submit`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text, requestId }),
        });

        assert.equal(response.status, 200, await response.clone().text());
        const sent = (await response.json()) as { submissionId: SubmissionId };

        await (await app.harness.submission(sent.submissionId, context))!.wait(context);

        return sent;
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

const toolText = (action: string, args: Record<string, unknown> = {}) =>
    `tool:${JSON.stringify({ action, ...args })}`;

async function finishReports(app: App, source: ConversationId) {
    const messages = await app.harness.snapshot(SessionMessagesDoc, source, context);

    for (const task of Object.values(messages?.items ?? {})) {
        await app.harness.waitForTask(task, context);
    }
}

async function assistantCount(app: App, source: ConversationId) {
    const page = await (await app.conversation(source)).entries({}, 100, undefined, context);

    return page.items.filter((entry) => entry.kind === "pi.assistant").length;
}

test("HTTP/tool submissions read and message ordinary sessions; reports are passive", async () => {
    const app = await openApp(toolModel(), join(root, "shared-tools-http"));

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await say(app, target, "project history");
        await (
            await app.conversation(source)
        ).configure(
            { extensions: { remove: [defineExtension({ name: "pocket-chief" })] } },
            context,
        );
        assert.ok(
            (await (await app.conversation(source)).agent(context)).tools.some(
                (tool) => tool.name === "sessions",
            ),
        );
        await httpSubmit(app, source, toolText("read", { sessionId: target }));
        assert.ok((await modelTexts(app, source)).some((text) => text.includes("project history")));
        await httpSubmit(
            app,
            source,
            toolText("message", { sessionId: target, message: "ordinary work" }),
        );
        const before = await assistantCount(app, source);

        await finishReports(app, source);
        assert.equal(await assistantCount(app, source), before, "report never wakes source");
        const texts = await modelTexts(app, source);

        assert.equal(
            texts.filter((text) => text.includes("Session report from session")).length,
            1,
        );
        assert.ok(texts.some((text) => text.includes(`Open session: /s/${target}`)));
        assert.ok(
            !(await modelTexts(app, target)).some((text) =>
                text.includes("Session report from session"),
            ),
            "reports return to requester session, not another session",
        );
        assert.equal(app.sessions().length, 2);
    } finally {
        await app.close();
    }
});

test("current requester permissions apply equally across sessions, never owner fallback", async () => {
    const app = await openApp(toolModel(), join(root, "shared-tools-permissions"));

    try {
        const source = await newSession(app);
        const target = await newSession(app);
        const other = await newSession(app);
        const scoped = app.config.addUser("Scoped", "guest", [String(source)]);

        await assert.rejects(app.sessionsTool.list(source), /No current requester/);

        await httpSubmit(app, source, toolText("read", { sessionId: target }), scoped.token);
        assert.equal(app.attribution.requesterOf(source), scoped.user.id);
        assert.ok((await modelTexts(app, source)).some((text) => text.includes("not shared")));
        assert.deepEqual(await app.sessionsTool.list(source), []);
        await assert.rejects(
            app.sessionsTool.message(source, {
                target,
                text: "work",
                mode: "followUp",
                key: "hidden",
            }),
            /not shared/,
        );
        await assert.rejects(
            app.sessionsTool.create(source, { cwd: work }, "scoped-create", {}),
            /cannot start new/,
        );
        await assert.rejects(
            app.sessionsTool.setArchived(source, target, true, "hidden-archive"),
            /not shared/,
        );
        await assert.rejects(
            app.sessionsTool.schedules(source, target, "schedule-list", { key: "hidden-list" }),
            /not shared/,
        );
        await assert.rejects(
            app.sessionsTool.schedules(source, target, "schedule-add", {
                key: "hidden-add",
                when: "in 10m",
                message: "work",
            }),
            /not shared/,
        );
        await assert.rejects(
            app.sessionsTool.schedules(source, target, "schedule-cancel", {
                key: "hidden-cancel",
                id: "missing",
            }),
            /not shared/,
        );
        const guest = app.config.addUser("Guest", "guest");

        await app.harness.commit(async (tx) => {
            const turns = await tx.doc(TurnsDoc, target);

            turns.on = true;
            turns.driver = owner(app).id;
        }, context);
        await httpSubmit(
            app,
            other,
            toolText("message", { sessionId: target, message: "must not escalate" }),
            guest.token,
        );
        assert.equal(app.attribution.requesterOf(other), guest.user.id);
        assert.ok((await modelTexts(app, other)).some((text) => text.includes("driving")));
        assert.equal(await app.harness.snapshot(SessionMessagesDoc, other, context), undefined);
        await app.harness.commit(async (tx) => {
            (await tx.doc(TurnsDoc, target)).on = false;
        }, context);
        await httpSubmit(app, other, "guest is requester", guest.token);
        await app.spend.setSessionBudget(owner(app), target, 0.01);
        await recordCost(app, target, 1);
        await assert.rejects(
            app.sessionsTool.message(other, {
                target,
                text: "work",
                mode: "followUp",
                key: "guest-spend",
            }),
            /limit|budget/i,
        );
        app.config.updateUser(guest.user.id, { role: "viewer" });
        await assert.rejects(
            app.sessionsTool.message(other, {
                target,
                text: "work",
                mode: "followUp",
                key: "viewer",
            }),
            /not steer/,
        );
        await assert.rejects(
            app.sessionsTool.setArchived(other, target, true, "viewer-archive"),
            /not steer/,
        );
        await assert.rejects(
            app.sessionsTool.create(other, { cwd: work }, "viewer-create", {}),
            /not steer/,
        );
        await assert.rejects(
            app.sessionsTool.schedules(other, target, "schedule-add", {
                key: "viewer-schedule",
                when: "in 10m",
                message: "work",
            }),
            /not steer/,
        );
    } finally {
        await app.close();
    }
});

test("drop-in removal/restart preserves message requester, replay and one passive report", async () => {
    let slow = true;
    const faux = scriptedModel(async (request, options) => {
        const { text } = lastText(request as never);

        if (text.includes("slow explicit work") && slow) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 5000);

                options?.signal?.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        resolve();
                    },
                    { once: true },
                );
            });
        }

        return fauxAssistantMessage([fauxText("finished @chief [@Project](/s/123)")]);
    });
    const data = join(root, "shared-tools-restart");
    let app = await openApp(faux, data);

    try {
        const source = await newSession(app);
        const target = await newSession(app);

        await say(app, source, "ready");
        const admittedBy = owner(app).id;
        const request = {
            target,
            text: "slow explicit work",
            mode: "followUp" as const,
            key: "stable-message",
        };
        const sent = await app.sessionsTool.message(source, request);

        await until(
            async () =>
                (await modelTexts(app, target)).some((text) => text.includes("slow explicit work")),
            "target admission",
        );
        const guest = app.config.addUser("New requester", "guest");

        await httpSubmit(app, source, "new unrelated request", guest.token);
        const count = await assistantCount(app, source);

        await app.harness.commit(async (tx) => {
            const turns = await tx.doc(TurnsDoc, target);

            turns.on = true;
            turns.driver = guest.user.id;
        }, context);
        app.loader.watch();
        // macOS starts directory watches asynchronously; do not delete before registration settles.
        await new Promise((resolve) => setTimeout(resolve, 100));
        rmSync(join(data, "extensions", "sessions-control.ts"));
        await until(
            () => !app.loader.extensionNames().includes("sessions-control"),
            "sessions drop-in removal",
        );
        await app.close();
        slow = false;
        app = await openCoreApp(faux, data);
        assert.equal(app.loader.files().includes("sessions-control.ts"), false);
        await finishReports(app, source);
        assert.equal(
            app.attribution.requesterOf(source),
            guest.user.id,
            "passive report is not new requester work",
        );
        assert.equal(await assistantCount(app, source), count);
        assert.deepEqual(await app.sessionsTool.message(source, request), sent);
        assert.equal(app.attribution.requesterOf(target), admittedBy);
        assert.equal(
            (await modelTexts(app, target)).filter((text) => text.includes("slow explicit work"))
                .length,
            1,
        );
        assert.equal(
            (await modelTexts(app, source)).filter((text) =>
                text.includes("Session report from session"),
            ).length,
            1,
        );
        assert.equal(
            Object.keys((await app.harness.snapshot(SessionMessagesDoc, source, context))!.items)
                .length,
            1,
        );
        await app.close();
        app = await openCoreApp(faux, data);
        assert.equal(
            app.attribution.requesterOf(source),
            guest.user.id,
            "restart also ignores passive report attribution",
        );
    } finally {
        await app.close();
    }
});

test("subagents execute the shared tool with their parent's requester, even with legacy Chief removal", async () => {
    const faux = scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        if (role !== "toolResult" && text.includes("spawn helper")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("subagent", {
                        action: "spawn",
                        name: "helper",
                        message: "list sessions",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role !== "toolResult" && text.includes("list sessions")) {
            return fauxAssistantMessage([fauxToolCall("sessions", { action: "list" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText(`result: ${text}`)]);
    });
    const app = await openApp(faux, join(root, "shared-tools-subagent"));

    try {
        const source = await newSession(app);
        const hidden = await newSession(app);
        const guest = app.config.addUser("Scoped parent", "guest", [String(source)]);

        await httpSubmit(app, source, "spawn helper", guest.token);
        const helper = (await app.harness.snapshot(SubagentsDoc, source, context))!.agents.helper!
            .conversationId;

        await (await app.conversation(helper)).waitForIdle(context);
        assert.equal(app.attribution.requesterOf(helper), guest.user.id);
        assert.ok(
            (await (await app.conversation(helper)).agent(context)).tools.some(
                (tool) => tool.name === "sessions",
            ),
        );
        const page = await (await app.conversation(helper)).entries({}, 100, undefined, context);
        const result = page.items.find(
            (entry) =>
                entry.kind === "pi.tool-result" &&
                JSON.stringify(entry.model).includes('"toolName":"sessions"'),
        );

        assert.ok(result, "helper executed the real shared tool");
        assert.ok(
            !JSON.stringify(result.model).includes(`\\\"id\\\":${hidden}`),
            "hidden project absent from tool result",
        );
        await assert.rejects(app.sessionsTool.read(helper, hidden), /not shared/);
    } finally {
        await app.close();
    }
});

test("literal mentions and stable Markdown references are ordinary HTTP messages, never automatic sends", async () => {
    const app = await openApp(toolModel(), join(root, "shared-tools-no-routing"));

    try {
        const source = await newSession(app);

        await httpSubmit(
            app,
            source,
            "@chief please consider [@Chief](/s/1697)",
            undefined,
            "literal-mention",
        );
        assert.equal(app.sessions().length, 1);
        assert.equal(await assistantCount(app, source), 1);
        assert.equal(await app.harness.snapshot(SessionMessagesDoc, source, context), undefined);
        assert.equal(await app.harness.snapshot(SessionReceiptsDoc, context), undefined);
        assert.ok(
            (await modelTexts(app, source)).some((text) => text.includes("received: @chief")),
        );
    } finally {
        await app.close();
    }
});
