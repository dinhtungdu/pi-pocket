// Former homes use the ordinary session list and stable-reference picker in a real browser.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { join } from "node:path";
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    say,
    until,
} from "./helpers.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

test(
    "former home appears in the workspace/list and picker without a singleton button or alias",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    },
    async () => {
        const app = await openApp(scriptedModel());
        const id = await newSession(app);
        const source = await newSession(app);

        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);

            sessions.items[String(id)]!.chiefFor = owner(app).id;
            sessions.items[String(id)]!.title = "Alfred";
        }, context);

        // Historical and newly emitted reports share the same navigation UI.
        for (const prefix of ["Chief", "Session"]) {
            await say(app, source, `[${prefix} report from session ${id}; no reply needed] done`);
        }

        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const browsers = new Browsers({
            dataDir: join(root, "sessions-ui"),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const page = await browsers.open(1);

            await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${source}`);
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(
                            `return JSON.stringify(document.querySelector('.session-row[data-id="${id}"]')?.textContent.includes("Alfred") ?? false)`,
                        ),
                    ),
                "former home in ordinary session list",
                20_000,
            );
            const result = JSON.parse(
                await page.evaluate(`
            const { workspaceOrder } = await import("/sessions.js");
            const { conversationMention, suggestConversations } = await import("/conversation-mentions.js");
            const { store } = await import("/store.js");
            const selected = suggestConversations(store.state.sessions, ${source}, "alfred")[0];
            return JSON.stringify({
                listed: workspaceOrder().some((session) => session.id === ${id}),
                reference: conversationMention(selected),
                alias: suggestConversations(store.state.sessions, ${source}, "chief").some((session) => session.id === ${id}),
                singletonButton: document.querySelector('button[title*="project coordinator"]') !== null,
                reports: [...document.querySelectorAll('.report-head')].map((head) => ({
                    name: head.querySelector('.report-name')?.textContent,
                    open: head.querySelector('button.link')?.textContent,
                })),
            });
        `),
            );

            assert.deepEqual(result, {
                listed: true,
                reference: `[@Alfred](/s/${id})`,
                alias: false,
                singletonButton: false,
                reports: [
                    { name: `Session ${id}`, open: "Open →" },
                    { name: `Session ${id}`, open: "Open →" },
                ],
            });

            for (const index of [0, 1]) {
                await page.navigate(`${base}/s/${source}`);
                await until(
                    async () =>
                        JSON.parse(
                            await page.evaluate(`
                                const buttons = document.querySelectorAll('.report-head button.link');
                                if (buttons.length !== 2) { return "false"; }
                                buttons[${index}].click();
                                return "true";
                            `),
                        ),
                    "report Open button",
                );
                await until(
                    async () =>
                        JSON.parse(
                            await page.evaluate(
                                `return JSON.stringify(location.pathname === "/s/${id}")`,
                            ),
                        ),
                    "report navigates to explicit session ID",
                );
            }
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
