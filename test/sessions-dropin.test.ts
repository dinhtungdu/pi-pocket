// The same filename hands the wrapper from built-in to owner source without duplicate registration or a tool gap.
import {
    cleanUp,
    newSession,
    openApp as openCoreApp,
    owner,
    root,
    scriptedModel,
    until,
    context,
} from "./helpers.ts";
import { sessionsSource, test } from "./owner-sessions.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { APP_ROOT } from "../src/server/config.ts";
import { resolveModel } from "../src/server/models.ts";
import type { PocketHost } from "../src/server/host.ts";
import { sessionQueue } from "../src/server/session-queue.ts";
import { ExtensionLoader, prepareDropInFolder } from "../src/server/reload.ts";

after(cleanUp);

test("owner sessions module defaults off, enables once through native app and stays enabled after restart", async () => {
    const data = join(root, "default-off");
    const directory = join(data, "extensions");
    const model = scriptedModel();

    mkdirSync(directory, { recursive: true });
    copyFileSync(sessionsSource, join(directory, "sessions.ts"));

    let app = await openCoreApp(model, data);

    try {
        const source = await newSession(app);
        const tools = async () => (await (await app.conversation(source)).agent(context)).tools;

        assert.equal(
            app.loader.list().find((item) => item.file === "sessions.ts")?.source,
            "drop-in",
        );
        assert.equal(app.loader.enabled("sessions.ts"), false);
        assert.equal((await tools()).filter((tool) => tool.name === "sessions").length, 0);
        await app.setExtensionEnabled(owner(app), "sessions.ts", true);
        assert.equal((await tools()).filter((tool) => tool.name === "sessions").length, 1);
        await app.close();
        app = await openCoreApp(model, data);
        assert.equal(app.loader.enabled("sessions.ts"), true);
        assert.equal((await tools()).filter((tool) => tool.name === "sessions").length, 1);
        assert.equal(
            app.loader.extensionNames().filter((name) => name === "pocket-sessions").length,
            1,
        );
    } finally {
        await app.close();
    }
});

test("native loader hands sessions to its enabled owner drop-in, keeps failed reload, and removes only wrapper", async () => {
    const app = await openCoreApp(scriptedModel(), join(root, "host"));
    const builtIn = join(root, "built-in");
    const dropIn = join(root, "drop-in");
    const builtinFile = join(builtIn, "sessions.ts");
    const ownerFile = join(dropIn, "sessions.ts");
    const registry = createRegistry();
    const choices = new Map<string, boolean>();
    const notices: string[] = [];
    const { treeMemoryHost } = await import("../src/server/tree-memory-host.ts");
    const host: PocketHost = {
        guard: app.guard,
        approvals: app.approvals,
        agentDir: root,
        dataDir: root,
        skillPaths: () => [],
        resolveModel: (spec) => resolveModel(app.models, spec),
        requesterOf: (id) => app.attribution.requesterOf(id),
        notice: (_level, message) => notices.push(message),
        sessions: app.sessionsTool,
        sessionQueue: sessionQueue(app),
        schedules: app.schedules,
        goals: app.goals,
        browsers: app.browsers,
        treeMemory: treeMemoryHost(app, () => true),
    };

    prepareDropInFolder(builtIn, join(APP_ROOT, "node_modules"));
    prepareDropInFolder(dropIn, join(APP_ROOT, "node_modules"));
    copyFileSync(sessionsSource, builtinFile);
    registry.install(defineExtension({ name: "pocket-core", tasks: [app.sessionsTool.task] }));

    const loader = new ExtensionLoader(registry, host, { builtIn, dropIn }, (file) =>
        choices.get(file),
    );
    const sessionTools = () =>
        registry
            .snapshot()
            .tools()
            .filter(({ tool }) => tool.name === "sessions");

    try {
        await loader.loadAll();
        loader.watch();
        assert.equal(sessionTools().length, 1);
        assert.equal(loader.list()[0]?.source, "built-in");

        copyFileSync(sessionsSource, ownerFile);
        await until(
            () => notices.some((text) => text.includes("is not loaded")),
            "collision notice",
        );
        assert.equal(sessionTools().length, 1);
        assert.equal(loader.list()[0]?.source, "built-in");

        // Preserve explicit filename enablement before removing the built-in: restart cannot default the drop-in off.
        choices.set("sessions.ts", true);
        rmSync(builtinFile);
        assert.equal(
            sessionTools().length,
            1,
            "removing built-in does not uninstall its running wrapper",
        );
        await loader.reload("sessions.ts");
        assert.equal(loader.list()[0]?.source, "drop-in");
        assert.equal(loader.list()[0]?.enabled, true);
        assert.equal(
            loader.extensionNames().filter((name) => name === "pocket-sessions").length,
            1,
        );
        assert.equal(sessionTools().length, 1);
        assert.equal(sessionTools()[0]?.tool.replay, "safe");

        // A fresh registry models restart: the saved choice loads the owner wrapper exactly once.
        const freshRegistry = createRegistry();
        const freshLoader = new ExtensionLoader(freshRegistry, host, { builtIn, dropIn }, (file) =>
            choices.get(file),
        );

        await freshLoader.loadAll();
        assert.equal(
            freshRegistry
                .snapshot()
                .tools()
                .filter(({ tool }) => tool.name === "sessions").length,
            1,
        );
        freshLoader.close();

        writeFileSync(ownerFile, "export default () => { throw new Error('broken edit'); };\n");
        await until(
            () => loader.list()[0]?.error?.includes("broken edit") === true,
            "failed reload",
        );
        assert.equal(sessionTools().length, 1);

        rmSync(ownerFile);
        await until(() => sessionTools().length === 0, "drop-in removal");
        assert.equal(registry.snapshot().task("pocket.chief-report"), app.sessionsTool.task);
        assert.equal(loader.extensionNames().includes("pocket-sessions"), false);

        mkdirSync(dropIn, { recursive: true });
        copyFileSync(sessionsSource, ownerFile);
        await until(() => sessionTools().length === 1, "enabled drop-in reinstalls");
    } finally {
        loader.close();
        await app.close();
    }
});
