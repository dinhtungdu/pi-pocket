// Incoming reports use the real transcript renderer, without changing their stored text.
import { cleanUp, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { Browsers, findBrowser } from "../src/server/browser.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { notificationPart } from "../src/server/notifications.ts";
import { context } from "./helpers.ts";
import { mkdirSync, writeFileSync } from "node:fs";

const longReport =
    "## Result\n\n**Verified** [documentation](https://example.com).\n\n```js\nconst answer = 42;\n```\n\n" +
    "Long report content. ".repeat(150) +
    "END OF FULL REPORT";

test(
    "session and subagent reports collapse by default and expand complete Markdown",
    {
        skip: findBrowser() === undefined ? "no Chromium" : false,
    },
    async () => {
        let release!: () => void;
        let holding = false;
        let spawned = false;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const app = await openApp(
            scriptedModel(async (request) => {
                if (JSON.stringify(request).includes("notification-ui-hold")) {
                    if (!spawned) {
                        spawned = true;

                        return fauxAssistantMessage(
                            [
                                fauxToolCall("subagent", {
                                    action: "spawn",
                                    name: "real-ui-worker",
                                    message: "report-ui-child",
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    holding = true;
                    await gate;
                }

                return fauxAssistantMessage([
                    fauxText(
                        JSON.stringify(request).includes("report-ui-child") ? longReport : "done",
                    ),
                ]);
            }),
        );
        const server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "report-browser"),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const source = await newSession(app);
            const target = await newSession(app);

            await app.commands.updateSession(source, owner(app), {
                title: "UI verification report",
            });
            const conversation = await app.conversation(target);

            for (const [name, type, text] of [
                ["session", "completion", longReport],
                ["helper", "failure", `failed: ${longReport}`],
                ["short", "review", "Short result."],
            ] as const) {
                await (
                    await conversation.submit(
                        {
                            type: "write",
                            entry: {
                                kind: "pi.user",
                                model: [
                                    {
                                        role: "user",
                                        timestamp: 1,
                                        content: [
                                            notificationPart(text, {
                                                type,
                                                source: name === "session" ? "session" : "subagent",
                                                name,
                                                sessionId:
                                                    name === "session"
                                                        ? Number(source)
                                                        : Number(target),
                                            }),
                                        ],
                                    },
                                ],
                            },
                        },
                        context,
                    )
                ).wait(context);
            }

            await app.commands.updateSession(target, owner(app), { title: "Notification UI test" });
            await say(app, target, "[subagent fake answered, no reply needed] ordinary user text");
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);
            const evaluate = async (script: string) => JSON.parse(await page.evaluate(script));

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${target}`);
            await until(
                async () =>
                    await evaluate(
                        "return JSON.stringify(document.querySelector('.activity-group summary')?.textContent === 'Activity · 3')",
                    ),
                "report cards",
            );

            assert.equal(
                await evaluate(
                    "return JSON.stringify(document.querySelector('.activity-group').open)",
                ),
                false,
            );
            assert.equal(
                await evaluate(
                    "return JSON.stringify(document.querySelector('.user-row').textContent.includes('[subagent fake answered'))",
                ),
                true,
            );
            await page.evaluate("document.querySelector('.activity-group').open = true");
            await new Promise((resolve) => setTimeout(resolve, 500));

            for (const width of [1280, 390]) {
                await page.setViewport({ width, height: 844, scale: 1, mobile: width === 390 });
                await new Promise((resolve) => setTimeout(resolve, 500));
                assert.equal(
                    await evaluate(
                        "return JSON.stringify([...document.querySelectorAll('.report [aria-expanded]')].every(b => b.getAttribute('aria-expanded') === 'false'))",
                    ),
                    true,
                );
                assert.equal(
                    await evaluate(
                        "return JSON.stringify(document.querySelector('.report-name').textContent)",
                    ),
                    "UI verification report",
                );
                assert.equal(
                    await evaluate(
                        "return JSON.stringify([...document.querySelectorAll('.report-preview')].every(p => p.textContent.length <= 181))",
                    ),
                    true,
                );
                assert.equal(
                    await evaluate(
                        "return JSON.stringify(document.querySelector('.report').getBoundingClientRect().height < 200)",
                    ),
                    true,
                );
                assert.equal(
                    await evaluate(
                        "return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)",
                    ),
                    true,
                );
                assert.equal(
                    await evaluate(
                        "return JSON.stringify(document.querySelector('.report-actions button').getBoundingClientRect().height >= 44)",
                    ),
                    true,
                );

                mkdirSync("/tmp/pocket-notification-evidence", { recursive: true });
                writeFileSync(
                    `/tmp/pocket-notification-evidence/${width}-activity.jpg`,
                    Buffer.from((await page.screenshot()).data, "base64"),
                );

                for (const index of [0, 1, 2]) {
                    await page.evaluate(
                        `document.querySelectorAll('.report [aria-expanded]')[${index}].click()`,
                    );
                    assert.equal(
                        await evaluate(
                            `return JSON.stringify(document.querySelectorAll('.report [aria-expanded]')[${index}].getAttribute('aria-expanded'))`,
                        ),
                        "true",
                    );
                    assert.equal(
                        await evaluate(
                            `return JSON.stringify(document.getElementById(document.querySelectorAll('.report [aria-expanded]')[${index}].getAttribute('aria-controls')).textContent.includes(${JSON.stringify(index === 2 ? "Short result." : "END OF FULL REPORT")}))`,
                        ),
                        true,
                    );

                    if (index !== 2) {
                        assert.equal(
                            await evaluate(
                                `return JSON.stringify(document.querySelectorAll('.report')[${index}].querySelector('pre code').textContent.includes('const answer = 42;'))`,
                            ),
                            true,
                        );
                        assert.equal(
                            await evaluate(
                                `return JSON.stringify(document.querySelectorAll('.report')[${index}].querySelector('a').href)`,
                            ),
                            "https://example.com/",
                        );
                    }

                    if (index === 0) {
                        await page.evaluate(
                            "document.querySelector('.report').scrollIntoView({ block: 'start' })",
                        );
                        await new Promise((resolve) => setTimeout(resolve, 300));
                        writeFileSync(
                            `/tmp/pocket-notification-evidence/${width}-expanded.jpg`,
                            Buffer.from((await page.screenshot()).data, "base64"),
                        );
                    }

                    await page.evaluate(
                        `document.querySelectorAll('.report [aria-expanded]')[${index}].click()`,
                    );
                }
            }

            assert.equal(
                await evaluate(
                    "return JSON.stringify(document.querySelector('.report.failed .report-head').textContent.includes('failed'))",
                ),
                true,
            );
            const active = await app.commands.submit(target, owner(app), {
                text: "notification-ui-hold",
                requestId: "ui-hold",
            });

            await until(() => holding, "held UI run");

            for (let index = 0; index < 11; index++) {
                await conversation.submit(
                    {
                        type: "input",
                        whenBusy: "followUp",
                        content: [
                            notificationPart(
                                `[subagent helper answered, no reply needed] ${longReport}`,
                                {
                                    type: "completion",
                                    source: "subagent",
                                    name: `worker-${index}`,
                                    sessionId: Number(source),
                                },
                            ),
                        ],
                    },
                    context,
                );
            }

            await app.commands.submit(target, owner(app), {
                text: "explicit visible queue",
                mode: "followUp",
                requestId: "ui-user-queue",
            });
            await until(
                async () =>
                    await evaluate(
                        "return JSON.stringify([...document.querySelectorAll('.activity-group summary')].some(s => s.textContent === 'Queued activity · 12'))",
                    ),
                "queued activity count",
            );
            assert.equal(
                await evaluate(
                    "return JSON.stringify([...document.querySelectorAll('.activity-group')].find(g => g.querySelector('summary').textContent === 'Queued activity · 12').textContent.includes('real-ui-worker'))",
                ),
                true,
            );
            assert.equal(
                await evaluate(
                    "return JSON.stringify(document.querySelectorAll('.composer-wrap .queued').length)",
                ),
                1,
            );
            assert.equal(
                await evaluate(
                    "return JSON.stringify(document.querySelector('.composer-wrap .queued').textContent.includes('explicit visible queue'))",
                ),
                true,
            );

            for (const width of [1280, 390]) {
                await page.setViewport({ width, height: 844, scale: 1, mobile: width === 390 });
                await new Promise((resolve) => setTimeout(resolve, 500));
                const summary =
                    "[...document.querySelectorAll('.activity-group summary')].find(s => s.textContent === 'Queued activity · 12')";

                await page.evaluate(`${summary}.scrollIntoView({ block: 'center' })`);
                await new Promise((resolve) => setTimeout(resolve, 300));
                assert.equal(
                    await evaluate(
                        `return JSON.stringify(${summary}.getBoundingClientRect().width > 0)`,
                    ),
                    true,
                );
                await page.evaluate(`${summary}.focus()`);
                await page.press("Enter");
                assert.equal(
                    await evaluate(`return JSON.stringify(${summary}.parentElement.open)`),
                    true,
                );
                await page.press("Enter");
                writeFileSync(
                    `/tmp/pocket-notification-evidence/${width}-queued.jpg`,
                    Buffer.from((await page.screenshot()).data, "base64"),
                );
                await page.evaluate(`${summary}.click()`);
                assert.equal(
                    await evaluate(`return JSON.stringify(${summary}.parentElement.open)`),
                    true,
                );
                assert.equal(
                    await evaluate(
                        `return JSON.stringify(${summary}.parentElement.textContent.includes('no reply needed'))`,
                    ),
                    false,
                );
                const realReport =
                    "[...document.querySelectorAll('.report')].find(r => r.querySelector('.report-name').textContent.includes('real-ui-worker'))";

                await page.evaluate(`${realReport}.querySelector('[aria-expanded]').click()`);
                assert.equal(
                    await evaluate(
                        `return JSON.stringify(${realReport}.textContent.includes('END OF FULL REPORT'))`,
                    ),
                    true,
                );
                await page.evaluate(`${realReport}.scrollIntoView({ block: 'start' })`);
                await new Promise((resolve) => setTimeout(resolve, 300));
                writeFileSync(
                    `/tmp/pocket-notification-evidence/${width}-queued-expanded.jpg`,
                    Buffer.from((await page.screenshot()).data, "base64"),
                );
                await page.evaluate(`${realReport}.querySelector('[aria-expanded]').click()`);
                await page.evaluate(`${summary}.click()`);
                assert.equal(
                    await evaluate(
                        "return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)",
                    ),
                    true,
                );
            }

            release();
            await (await app.harness.submission(active.submissionId, context))!.wait(context);
            await page.evaluate(
                "document.querySelector('.report-actions button:nth-child(2)').click()",
            );
            await until(
                async () =>
                    await evaluate(`return JSON.stringify(location.pathname === '/s/${source}')`),
                "open source session",
            );
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            release();
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
            cleanUp();
        }
    },
);
