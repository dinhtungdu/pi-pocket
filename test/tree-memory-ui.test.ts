// Real Chromium controls + the same driver/visibility permissions used by commands and tools.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { TurnsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { TreeMemoryDoc, TreeNodeDoc } from "../src/server/tree-memory.ts";

after(cleanUp);

async function install(app: App) {
    copyFileSync("extensions/tree-memory.ts", join(app.dataDir, "extensions", "tree-memory.ts"));
    await until(
        () => app.loader.list().some((module) => module.file === "tree-memory.ts"),
        "tree drop-in discovered",
    );
    await app.setExtensionEnabled(owner(app), "tree-memory.ts", true);
}

function codex(app: App, fail: () => boolean = () => false) {
    const model = fauxProvider({
        provider: "openai-codex",
        models: [
            { id: "gpt-6-luna", reasoning: true },
            { id: "synthetic-alt", reasoning: true },
            { id: "no-reasoning", reasoning: false },
        ],
        tokensPerSecond: 2000,
    });

    model.setResponses(
        Array.from(
            { length: 100 },
            () => () =>
                fail()
                    ? fauxAssistantMessage("", {
                          stopReason: "error",
                          errorMessage: "scripted compression failure",
                      })
                    : fauxAssistantMessage("summary"),
        ),
    );
    app.models.registerNativeProvider(model.provider);

    return app.models.refresh({ providers: ["openai-codex"], allowNetwork: false });
}

test("UI command and tool share exact visibility/steering/driver authorization; guest can opt in", async () => {
    const app = await openApp(scriptedModel(), join(root, "tree-rights"));

    try {
        await install(app);
        await codex(app);
        const id = await newSession(app);
        const other = await newSession(app);
        const guest = app.config.addUser("Guest", "guest").user;
        const settings = {
            model: { provider: "openai-codex", modelId: "gpt-6-luna" },
            thinkingLevel: "medium",
        };

        await app.commands.configureTreeMemory(id, guest, settings);
        assert.equal((await app.treeMemory.status(id, context)).thinkingLevel, "medium");
        await app.commands.setTreeMemory(id, guest, true);
        assert.equal((await app.harness.snapshot(TreeMemoryDoc, id, context))!.enabled, true);
        await app.commands.setTreeMemory(id, guest, false);
        const sent = await app.commands.submit(id, guest, {
            text: "guest is requester",
            requestId: "guest-tree",
        });

        await (await app.harness.submission(sent.submissionId, context))!.wait(context);
        app.config.updateUser(guest.id, { role: "viewer" });
        const viewer = app.config.userById(guest.id)!;

        await assert.rejects(app.commands.configureTreeMemory(id, viewer, settings), {
            status: 403,
        });
        await assert.rejects(app.commands.setTreeMemory(id, viewer, true), { status: 403 });
        await assert.rejects(app.treeMemory.set(id, true, undefined, true, context), {
            status: 403,
        });
        app.config.updateUser(guest.id, { role: "guest" });
        await app.harness.commit(async (tx) => {
            const turns = await tx.doc(TurnsDoc, id);

            turns.on = true;
            turns.driver = owner(app).id;
        }, context);
        await assert.rejects(
            app.commands.configureTreeMemory(id, app.config.userById(guest.id)!, settings),
            { status: 409 },
        );
        await assert.rejects(app.commands.setTreeMemory(id, app.config.userById(guest.id)!, true), {
            status: 409,
        });
        await assert.rejects(app.treeMemory.set(id, true, undefined, true, context), {
            status: 409,
        });
        app.config.updateUser(guest.id, { sessions: [String(other)] });
        await assert.rejects(
            app.commands.configureTreeMemory(id, app.config.userById(guest.id)!, settings),
            { status: 404 },
        );
        await assert.rejects(app.commands.setTreeMemory(id, app.config.userById(guest.id)!, true), {
            status: 404,
        });
        await assert.rejects(app.treeMemory.set(id, true, undefined, true, context), {
            status: 404,
        });
        assert.equal((await app.harness.snapshot(TreeMemoryDoc, id, context))!.enabled, false);
    } finally {
        await app.close();
    }
});

test(
    "real mobile Chromium session menu enables/prepares/activates/errors/disables tree memory",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser" : false,
    },
    async () => {
        let fail = false;
        const requests: Message[][] = [];
        const app = await openApp(
            scriptedModel((request) => {
                requests.push(structuredClone([...request.messages]));

                return fauxAssistantMessage("answer");
            }),
            join(root, "tree-ui"),
        );

        await install(app);
        await codex(app, () => fail);
        const id = await newSession(app);

        await say(app, id, "synthetic prior evidence ".repeat(100));
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const browsers = new Browsers({
            dataDir: join(root, "tree-ui-browser"),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const page = await browsers.open(1);

            await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${id}`);
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(
                            `const {store} = await import('/store.js'); return JSON.stringify(store.state.view.treeMemory?.available === true);`,
                        ),
                    ),
                "memory status delivered to real browser",
                20_000,
            );
            await page.evaluate(
                `const {openSheet} = await import('/store.js'); openSheet({type:'menu'});`,
            );
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(
                            `const button = [...document.querySelectorAll('button.list-item')].find((b) => b.firstElementChild?.textContent === 'Tree memory'); if(!button) return 'false'; button.click(); return 'true';`,
                        ),
                    ),
                "actual session-menu memory control",
            );
            const state = () =>
                page
                    .evaluate(
                        `return JSON.stringify({status:document.querySelector('.sheet [role="status"]')?.textContent,checked:document.querySelector('button[role="switch"][aria-label="Tree memory"]')?.getAttribute('aria-checked'),text:document.querySelector('.sheet')?.textContent});`,
                    )
                    .then(JSON.parse);

            await until(async () => (await state()).status === "Off", "off feedback");
            assert.match((await state()).text, /costs model calls/);
            const defaults = JSON.parse(
                await page.evaluate(
                    `return JSON.stringify({ model: document.querySelector('#compressor-model').value, level: document.querySelector('#compressor-thinking').value, levels: [...document.querySelector('#compressor-thinking').options].map(o => o.value) });`,
                ),
            );

            assert.equal(defaults.model, "openai-codex/gpt-6-luna");
            assert.equal(defaults.level, "high");
            assert.ok(["low", "medium", "high"].every((level) => defaults.levels.includes(level)));
            writeFileSync(
                "tmp/alfred-tree-memory/ui-compressor-default-mobile.jpg",
                Buffer.from((await page.screenshot()).data, "base64"),
            );
            await page.evaluate(
                `document.querySelector('button[role="switch"][aria-label="Tree memory"]').click();`,
            );
            await until(async () => (await state()).status === "Preparing", "preparing feedback");
            assert.equal((await state()).checked, "true");
            assert.equal(
                (await app.harness.snapshot(TreeMemoryDoc, id, context))!.phase,
                "warming",
            );
            fail = true;
            await say(app, id, "first fresh memory turn");
            await until(async () => (await state()).status === "Error", "warmup cause surfaced");
            assert.match((await state()).text, /scripted compression failure/);
            assert.match((await state()).text, /Resume preparation/);
            assert.equal(
                (await app.harness.snapshot(TreeMemoryDoc, id, context))!.phase,
                "warming",
            );
            writeFileSync(
                "tmp/alfred-tree-memory/ui-warmup-cause-mobile.jpg",
                Buffer.from((await page.screenshot()).data, "base64"),
            );
            fail = false;
            await page.evaluate(
                `const button = [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.trim() === 'Resume preparation'); button.click();`,
            );
            await until(
                async () => (await state()).status === "Active",
                "explicit resume finishes autonomously, no user input",
            );
            await say(app, id, "fresh ready turn");
            await until(async () => (await state()).status === "Active", "active feedback");
            assert.ok(JSON.stringify(requests.at(-1)).includes("Historical memory"));
            writeFileSync(
                "tmp/alfred-tree-memory/ui-active-mobile.jpg",
                Buffer.from((await page.screenshot()).data, "base64"),
            );
            const oldNode = await app.harness.snapshot(TreeNodeDoc, id, "0+1", context);

            await page.evaluate(
                `const model=document.querySelector('#compressor-model'); model.value='openai-codex/synthetic-alt'; model.dispatchEvent(new Event('change',{bubbles:true}));`,
            );
            await page.evaluate(
                `const level=document.querySelector('#compressor-thinking'); level.value='low'; level.dispatchEvent(new Event('change',{bubbles:true}));`,
            );
            await page.evaluate(
                `[...document.querySelectorAll('.sheet button')].find(b=>b.textContent.trim()==='Save compressor').click();`,
            );
            await until(
                async () =>
                    (await app.treeMemory.status(id, context)).model.modelId === "synthetic-alt",
                "UI model settings persisted",
            );
            assert.equal((await app.treeMemory.status(id, context)).thinkingLevel, "low");
            assert.equal((await app.treeMemory.status(id, context)).ready, true);
            assert.deepEqual(await app.harness.snapshot(TreeNodeDoc, id, "0+1", context), oldNode);
            await page.navigate(`${base}/s/${id}`);
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(
                            `const {store}=await import('/store.js'); return JSON.stringify(store.state.view.treeMemory?.model?.modelId === 'synthetic-alt');`,
                        ),
                    ),
                "selected model survives real browser reload",
            );
            await page.evaluate(
                `const {openSheet}=await import('/store.js'); openSheet({type:'tree-memory'});`,
            );
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(
                            `return JSON.stringify(document.querySelector('#compressor-thinking')?.value === 'low');`,
                        ),
                    ),
                "selected effort rendered after reload",
            );
            // The mobile sheet slides in; capture the settled layout, not a mid-animation translucent frame.
            await new Promise((resolve) => setTimeout(resolve, 350));
            const geometry = JSON.parse(
                await page.evaluate(
                    `const sheet=document.querySelector('.sheet'); return JSON.stringify({ width:sheet.clientWidth,scroll:sheet.scrollWidth, right:Math.max(...[...sheet.querySelectorAll('select')].map(e=>e.getBoundingClientRect().right)), viewport:innerWidth });`,
                ),
            );

            assert.ok(geometry.scroll <= geometry.width, "no horizontal overflow on mobile");
            assert.ok(geometry.right <= geometry.viewport, "selectors stay in mobile viewport");
            writeFileSync(
                "tmp/alfred-tree-memory/ui-compressor-selected-mobile.jpg",
                Buffer.from((await page.screenshot()).data, "base64"),
            );
            fail = true;
            await say(app, id, "long historical input ".repeat(100));
            await say(app, id, "must fail closed");
            await until(async () => (await state()).status === "Error", "error feedback");
            assert.match((await state()).text, /scripted compression failure/);
            assert.ok(!JSON.stringify(requests.at(-1)).includes("must fail closed"));
            writeFileSync(
                "tmp/alfred-tree-memory/ui-error-mobile.jpg",
                Buffer.from((await page.screenshot()).data, "base64"),
            );
            await app.harness.commit(async (tx) => {
                (await tx.doc(TreeMemoryDoc, id)).model = {
                    provider: "removed-provider",
                    modelId: "unavailable-choice",
                };
            }, context); // Simulate a persisted selected model whose provider was removed; never silently substitute.
            await until(
                async () =>
                    (await state()).text.includes(
                        "removed-provider/unavailable-choice (unavailable)",
                    ),
                "unavailable actual saved model shown",
            );
            assert.match((await state()).text, /no model will be substituted/);
            writeFileSync(
                "tmp/alfred-tree-memory/ui-compressor-unavailable-mobile.jpg",
                Buffer.from((await page.screenshot()).data, "base64"),
            );
            await page.evaluate(
                `document.querySelector('button[role="switch"][aria-label="Tree memory"]').click();`,
            );
            await until(async () => (await state()).status === "Off", "disable feedback");
            assert.equal((await state()).checked, "false");
            await say(app, id, "normal after UI disable");
            assert.ok(!JSON.stringify(requests.at(-1)).includes("Historical memory"));
            const browserState = JSON.parse(
                await page.evaluate(
                    `const {store}=await import('/store.js'); return JSON.stringify(store.state.view.treeMemory);`,
                ),
            );

            assert.equal("view" in browserState, false);
            assert.equal("main" in browserState, false);
            assert.equal("queue" in browserState, false);
            assert.equal(page.state(true).errors, 0, "actual browser console has no errors");
            writeFileSync(
                "tmp/alfred-tree-memory/ui-proof.json",
                JSON.stringify(
                    {
                        viewport: "390x844",
                        states: [
                            "Off",
                            "Preparing",
                            "Error (warmup cause)",
                            "Resume → Active without new input",
                            "Error (mandatory)",
                            "Off",
                        ],
                        consoleErrors: page.state(true).errors,
                        statusFields: Object.keys(browserState),
                    },
                    null,
                    2,
                ),
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
