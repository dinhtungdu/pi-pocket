// Exercise the owner wrapper through the native loader and requester-scoped creation service.
import {
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";
import { openApp, test } from "./owner-sessions.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SessionReceiptsDoc } from "../src/server/docs.ts";

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const model = () =>
    scriptedModel((request) => {
        const { role, text } = lastText(request as never);
        const at = text.indexOf("tool:");

        return role !== "toolResult" && at !== -1
            ? fauxAssistantMessage([fauxToolCall("sessions", JSON.parse(text.slice(at + 5)))], {
                  stopReason: "toolUse",
              })
            : fauxAssistantMessage([fauxText(`received: ${text}`)]);
    });
const create = (cwd: string, title: string, worktree?: unknown) =>
    `tool:${JSON.stringify({ action: "create", cwd, title, ...(worktree === undefined ? {} : { worktree }) })}`;

after(cleanUp);

test("sessions.create uses native snapshot isolation, defaults and persisted replay receipts", async () => {
    const repo = join(root, "repo");
    const folder = join(repo, "app");
    const data = join(root, "native-create");

    mkdirSync(folder, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(folder, "tracked.txt"), "HEAD\n");
    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "fixture");
    const head = git(repo, "rev-parse", "HEAD");

    writeFileSync(join(folder, "tracked.txt"), "snapshot\n");
    writeFileSync(join(folder, "new.txt"), "untracked\n");
    mkdirSync(join(repo, "ignored"));
    writeFileSync(join(repo, "ignored", "secret.txt"), "excluded\n");
    let app = await openApp(model(), data);

    try {
        const source = await newSession(app);

        await say(app, source, create(folder, "Native isolated", true));
        const target = app.sessions().find((session) => session.title === "Native isolated")!
            .id as typeof source;
        const meta = app.sessionMeta(target)!;
        const tree = meta.worktree!;

        assert.ok(tree, "true must reach native service, not silently create in source");
        assert.equal(tree.source, folder);
        assert.ok(tree.path.startsWith(join(data, "worktrees")));
        assert.match(tree.branch, /^pocket\/native-isolated-[0-9a-f]{6}$/);
        assert.equal(meta.cwd, join(tree.path, "app"));
        assert.equal(git(meta.cwd, "rev-parse", "HEAD"), head);
        assert.equal(git(meta.cwd, "branch", "--show-current"), tree.branch);
        assert.equal(readFileSync(join(meta.cwd, "tracked.txt"), "utf8"), "snapshot\n");
        assert.equal(readFileSync(join(meta.cwd, "new.txt"), "utf8"), "untracked\n");
        assert.equal(existsSync(join(tree.path, "ignored")), false);
        writeFileSync(join(meta.cwd, "tracked.txt"), "isolated\n");
        assert.equal(readFileSync(join(folder, "tracked.txt"), "utf8"), "snapshot\n");
        const receipts = (await app.harness.snapshot(SessionReceiptsDoc, context))!.creates;
        const key = Object.keys(receipts).find((key) => receipts[key] === target)!;
        const before = git(repo, "worktree", "list", "--porcelain");
        const branches = git(repo, "branch", "--list");

        await say(app, source, create(folder, "False", false));
        await say(app, source, create(folder, "Omitted"));

        for (const title of ["False", "Omitted"]) {
            const session = app.sessions().find((session) => session.title === title)!;

            assert.equal(session.cwd, folder);
            assert.equal(app.sessionMeta(session.id as typeof source)?.worktree, undefined);
        }

        await app.close();
        app = await openApp(model(), data);
        const replay = await app.sessionsTool.create(
            source,
            { cwd: folder, worktree: true },
            key,
            {},
        );

        assert.equal(replay.id, target);
        assert.equal(git(repo, "worktree", "list", "--porcelain"), before);
        assert.equal(git(repo, "branch", "--list"), branches);
        assert.equal(readdirSync(join(data, "worktrees")).length, 1);
        assert.equal(app.sessions().length, 4);

        // Fail after native allocation: the existing service must undo folder and branch.
        const commit = app.harness.commit;

        app.harness.commit = async () => {
            throw new Error("injected creation transaction failure");
        };

        try {
            await assert.rejects(
                app.sessionsTool.create(
                    source,
                    { cwd: folder, worktree: true },
                    "failed-create",
                    {},
                ),
                /injected creation transaction failure/,
            );
        } finally {
            app.harness.commit = commit;
        }

        assert.equal(git(repo, "worktree", "list", "--porcelain"), before);
        assert.equal(git(repo, "branch", "--list"), branches);
        assert.equal(readdirSync(join(data, "worktrees")).length, 1);
        assert.equal(app.sessions().length, 4);
    } finally {
        await app.close();
    }
});

test("sessions.create rejects invalid boolean, missing cwd and non-Git without debris", async () => {
    const data = join(root, "invalid-create");
    const app = await openApp(model(), data);

    try {
        const source = await newSession(app);

        for (const [cwd, title, flag, error] of [
            [work, "Invalid flag", { invalid: true }, /boolean/i],
            [join(root, "missing"), "Missing", true, /directory|folder|exist/i],
            [work, "Non Git", true, /not in a git repository/i],
        ] as const) {
            await say(app, source, create(cwd, title, flag));
            const texts = await modelTexts(app, source);

            assert.ok(
                texts.some((text) => error.test(text)),
                JSON.stringify({ title, texts }),
            );
            assert.equal(app.sessions().length, 1);
            assert.equal(existsSync(join(data, "worktrees")), false);
            assert.deepEqual(
                (await app.harness.snapshot(SessionReceiptsDoc, context))?.creates ?? {},
                {},
            );
        }
    } finally {
        await app.close();
    }
});
