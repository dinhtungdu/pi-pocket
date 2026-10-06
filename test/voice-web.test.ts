import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function inputClass(globals: Record<string, unknown>) {
    const context: Record<string, any> = {
        AbortController,
        setTimeout,
        clearTimeout,
        ...globals,
    };
    const source = readFileSync(new URL("../web/voice-input.js", import.meta.url), "utf8");

    runInNewContext(
        source.replace("export class VoiceInput", "globalThis.VoiceInput = class VoiceInput"),
        context,
    );

    return context.VoiceInput;
}

test("voice permission failure closes audio and reports error without starting a worker", async () => {
    let closed = 0;
    const errors: string[] = [];
    const VoiceInput = inputClass({
        window: { AudioWorkletNode: true },
        navigator: {
            mediaDevices: {
                getUserMedia: async () => {
                    throw new Error("Permission denied");
                },
            },
        },
        AudioContext: class {
            async resume() {}
            async close() {
                closed++;
            }
        },
        fetch: () => assert.fail("worker must not start without microphone permission"),
    });
    const input = new VoiceInput("1", { onError: (message: string) => errors.push(message) });

    await input.start();
    assert.equal(closed, 1);
    assert.deepEqual(errors, ["Permission denied"]);
});

test("closing during microphone permission releases tracks once permission resolves", async () => {
    let permission: ((value: unknown) => void) | undefined;
    let stopped = 0;
    const VoiceInput = inputClass({
        window: { AudioWorkletNode: true },
        navigator: {
            mediaDevices: {
                getUserMedia: () =>
                    new Promise((resolve) => {
                        permission = resolve;
                    }),
            },
        },
        AudioContext: class {
            async resume() {}
            async close() {}
        },
        fetch: () => assert.fail("cancelled capture must not start a worker"),
    });
    const input = new VoiceInput("1", { onError: () => assert.fail("cancel is not an error") });
    const starting = input.start();

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(permission);
    input.close();
    permission({ getTracks: () => [{ stop: () => stopped++ }] });
    await starting;
    assert.equal(stopped, 1);
});

test("Stop during worker startup cancels quietly without uploading PCM", async () => {
    const calls: string[] = [];
    const phases: string[] = [];
    const VoiceInput = inputClass({
        fetch: async (_url: string, options: { method: string }) => {
            calls.push(options.method);
        },
    });
    const input = new VoiceInput("1", {
        onState: (phase: string) => phases.push(phase),
        onError: () => assert.fail("startup cancellation should not show an error"),
    });

    input.url = "/api/c/1/voice/test";
    assert.equal(await input.stop(), false);
    assert.deepEqual(calls, ["DELETE"]);
    assert.deepEqual(phases, ["finishing", "off"]);
});

test("drain timeout preserves the partial draft but prevents automatic sending", async () => {
    const sizes: number[] = [];
    const text: string[] = [];
    const VoiceInput = inputClass({
        setTimeout: (callback: () => void, ms: number) =>
            ms >= 20000 ? undefined : setTimeout(callback, 0),
        fetch: async (
            _url: string,
            options: { method: string; body?: Uint8Array; headers: Record<string, string> },
        ) => {
            assert.equal(options.headers["X-Pocket"], "1");

            if (options.method === "POST" && options.body) {
                sizes.push(options.body.byteLength);
            }

            return { ok: true, json: async () => ({ ok: true }) };
        },
    });
    const input = new VoiceInput("1", {
        onState: () => {},
        onInterim: () => {},
        onText: (phrase: string) => text.push(phrase),
        onError: (message: string) => assert.match(message, /Review the draft/),
    });

    input.url = "/api/c/1/voice/test";
    input.node = { disconnect: () => {}, port: {} };
    input.chunks = [new Uint8Array(640)];
    input.bytes = 640;
    input.interim = "last phrase";
    assert.equal(await input.stop(), false);
    assert.deepEqual(sizes, [640, 32000, 32000, 32000]);
    assert.deepEqual(text, ["last phrase"]);
    assert.equal(input.closed, true);
    assert.equal(await input.stop(), false);
});

test("closing during session creation still obtains its id and deletes the worker", async () => {
    let created: ((value: unknown) => void) | undefined;
    let creationSignal: AbortSignal | undefined;
    const methods: string[] = [];
    const VoiceInput = inputClass({
        window: { AudioWorkletNode: true },
        navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
        AudioContext: class {
            audioWorklet = { addModule: async () => {} };
            async resume() {}
            async close() {}
        },
        fetch: async (_url: string, options: { method: string; signal?: AbortSignal }) => {
            methods.push(options.method);

            if (options.method === "POST") {
                creationSignal = options.signal;

                return new Promise((resolve) => {
                    created = resolve;
                });
            }

            return { ok: true, json: async () => ({ ok: true }) };
        },
    });
    const input = new VoiceInput("1", {
        onError: () => assert.fail("cancellation is not an error"),
    });
    const starting = input.start();

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(created);
    input.close();
    assert.equal(creationSignal?.aborted, false);
    created({ ok: true, json: async () => ({ id: "created-after-stop" }) });
    await starting;
    assert.deepEqual(methods, ["POST", "DELETE"]);
});

test("Stop waits for the worker drain acknowledgement and retains a late final", async () => {
    let deliver: ((value: unknown) => void) | undefined;
    const text: string[] = [];
    const response = (body: unknown) => ({ ok: true, json: async () => body });
    const VoiceInput = inputClass({
        setTimeout: (callback: () => void, ms: number) =>
            setTimeout(callback, ms === 100 ? 0 : ms === 8000 ? 1000 : ms),
        fetch: async (url: string, options: { method?: string; signal?: AbortSignal }) => {
            if (options.method === "POST" && url.endsWith("/finish")) {
                setTimeout(
                    () =>
                        deliver?.(
                            response({
                                events: [
                                    { type: "final", text: "complete late phrase" },
                                    { type: "flushed" },
                                ],
                            }),
                        ),
                    30,
                );
            }

            if (!options.method) {
                return new Promise((resolve, reject) => {
                    deliver = resolve;
                    options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                        once: true,
                    });
                });
            }

            return response({ ok: true });
        },
    });
    const input = new VoiceInput("1", {
        onState: () => {},
        onInterim: () => {},
        onText: (phrase: string) => text.push(phrase),
        onError: () => assert.fail("late final should not fail"),
    });

    input.url = "/api/c/1/voice/test";
    input.node = { disconnect: () => {}, port: {} };
    input.interim = "incomplete";
    void input.poll();
    assert.equal(await input.stop(), true);
    assert.deepEqual(text, ["complete late phrase"]);
    assert.equal(input.closed, true);
});

for (const rate of [16000, 44100, 48000]) {
    test(`voice worklet resamples ${rate} Hz into little-endian 16 kHz PCM`, () => {
        const messages: ArrayBuffer[] = [];
        let Processor: any;

        runInNewContext(readFileSync(new URL("../web/voice-worklet.js", import.meta.url), "utf8"), {
            sampleRate: rate,
            AudioWorkletProcessor: class {
                port = {
                    postMessage: (bytes: ArrayBuffer) => messages.push(bytes),
                };
            },
            registerProcessor: (_name: string, value: any) => {
                Processor = value;
            },
        });
        const processor = new Processor();
        const input = new Float32Array(rate).fill(0.5);

        for (let offset = 0; offset < input.length; offset += 128) {
            assert.equal(processor.process([[input.subarray(offset, offset + 128)]]), true);
        }

        // At most one incomplete 20 ms frame is buffered for a non-integral device rate.
        const count = messages.reduce((sum, frame) => sum + frame.byteLength / 2, 0);

        assert.ok(count >= 15680 && count <= 16000, `unexpected sample count: ${count}`);

        for (const frame of messages) {
            const view = new DataView(frame);

            assert.equal(frame.byteLength, 640);
            assert.equal(view.getInt16(0, true), 16384);
        }
    });
}

test("voice worklet clamps samples instead of wrapping", () => {
    let Processor: any;
    let frame: ArrayBuffer | undefined;

    runInNewContext(readFileSync(new URL("../web/voice-worklet.js", import.meta.url), "utf8"), {
        sampleRate: 16000,
        AudioWorkletProcessor: class {
            port = {
                postMessage: (bytes: ArrayBuffer) => {
                    frame = bytes;
                },
            };
        },
        registerProcessor: (_name: string, value: any) => {
            Processor = value;
        },
    });
    const input = new Float32Array(320).fill(2);

    input[1] = -2;
    new Processor().process([[input]]);
    assert.ok(frame);
    const view = new DataView(frame);

    assert.equal(view.getInt16(0, true), 32767);
    assert.equal(view.getInt16(2, true), -32767);
});
