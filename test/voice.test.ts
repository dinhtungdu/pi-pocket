import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "node:stream";
import type { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { HttpError } from "../src/server/errors.ts";
import { MAX_VOICE_PCM, VoiceSessions, type VoiceEvent } from "../src/server/voice.ts";

const directory = mkdtempSync(join(tmpdir(), "pocket-voice-"));
const workerPath = join(directory, "worker.cjs");

writeFileSync(
    workerPath,
    `#!${process.execPath}
const mode = process.argv[2];
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (mode === 'exit') process.exit(1);
if (mode === 'invalid') process.stdout.write('not json\\n');
else if (mode === 'oversize') process.stdout.write('x'.repeat(20000));
else if (mode === 'flood') for (let i = 0; i < 200; i++) emit({type:'final', text:'overflow'});
else {
    emit({type:'ready', sampleRate:16000});
    let data = Buffer.alloc(0);
    if (mode !== 'stalled') process.stdin.on('data', chunk => {
        data = Buffer.concat([data, chunk]);
        while (data.length >= 5 && data.length >= 5 + data.readUInt32LE(1)) {
            const length = data.readUInt32LE(1);
            if (data[0] === 2 && length === 0) {
                emit({type:'reset'});
                data = data.subarray(5);
                continue;
            }
            if (data[0] !== 1 || length % 2) process.exit(2);
            const text = mode === 'silence' ? 'silence' : data.subarray(5, 5 + length).toString('hex');
            emit({type:'interim', text});
            emit({type:'final', text});
            data = data.subarray(5 + length);
        }
    });
}
setInterval(() => {}, 1000);
`,
);
chmodSync(workerPath, 0o700);
after(() => rmSync(directory, { recursive: true, force: true }));

function backend(modelPath = "normal", inactivityMs = 60_000): VoiceSessions {
    return new VoiceSessions({ workerPath, modelPath, pollMs: 1000, inactivityMs });
}

function status(code: number) {
    return (error: unknown) => error instanceof HttpError && error.status === code;
}

test("fake native worker: ready, binary framing, interim/final, empty poll and delete", async () => {
    const voice = backend();
    const id = voice.start("alice", "1");

    try {
        assert.throws(() => voice.push("alice", "1", id, Buffer.alloc(2)), status(409));
        assert.deepEqual(await voice.poll("alice", "1", id), [
            { type: "ready", sampleRate: 16000 },
        ]);
        voice.push("alice", "1", id, Buffer.from([0, 1, 255, 127]));
        const events = await voice.poll("alice", "1", id);

        if (events.length === 1) {
            events.push(...(await voice.poll("alice", "1", id)));
        }

        assert.deepEqual(events, [
            { type: "interim", text: "0001ff7f" },
            { type: "final", text: "0001ff7f" },
        ]);
        const controller = new AbortController();
        const waiting = voice.poll("alice", "1", id, controller.signal);

        await assert.rejects(voice.poll("alice", "1", id), status(409));
        controller.abort();
        assert.deepEqual(await waiting, []);
        voice.delete("alice", "1", id);
        await assert.rejects(voice.poll("alice", "1", id), status(404));
    } finally {
        voice.close();
    }
});

test("finish acknowledges native PCM drain after all transcription events", async () => {
    const voice = backend();
    const id = voice.start("alice", "1");

    try {
        await voice.poll("alice", "1", id);
        voice.push("alice", "1", id, Buffer.from([0, 1]));
        voice.finish("alice", "1", id);
        assert.throws(() => voice.push("alice", "1", id, Buffer.alloc(2)), status(409));
        const events: VoiceEvent[] = [];

        for (let i = 0; i < 3 && !events.some((event) => event.type === "flushed"); i++) {
            events.push(...(await voice.poll("alice", "1", id)));
        }

        assert.deepEqual(events, [
            { type: "interim", text: "0001" },
            { type: "final", text: "0001" },
            { type: "flushed" },
        ]);
    } finally {
        voice.close();
    }
});

test("session ownership, conversation scope, replacement, PCM bounds", async () => {
    const voice = backend();
    const id = voice.start("alice", "1");

    try {
        await assert.rejects(voice.poll("bob", "1", id), status(404));
        await assert.rejects(voice.poll("alice", "2", id), status(404));
        assert.throws(() => voice.delete("bob", "1", id), status(404));
        await voice.poll("alice", "1", id);

        for (const size of [0, 1, 3, MAX_VOICE_PCM + 2]) {
            assert.throws(
                () => voice.push("alice", "1", id, Buffer.alloc(size)),
                status(size > MAX_VOICE_PCM ? 413 : 400),
            );
        }

        const waiting = voice.poll("alice", "1", id);
        const replacement = voice.start("alice", "2");

        assert.deepEqual(await waiting, []);
        await assert.rejects(voice.poll("alice", "1", id), status(404));
        assert.deepEqual(await voice.poll("alice", "2", replacement), [
            { type: "ready", sampleRate: 16000 },
        ]);
    } finally {
        voice.close();
    }
});

for (const mode of ["exit", "invalid", "oversize", "flood"]) {
    test(`worker ${mode} becomes a bounded terminal error`, async () => {
        const voice = backend(mode);
        const id = voice.start("alice", "1");

        try {
            if (mode === "flood") {
                await new Promise((resolve) => setTimeout(resolve, 200));
            }

            let events = await voice.poll("alice", "1", id);

            for (
                let attempts = 0;
                attempts < 5 && !events.some((event) => event.type === "error");
                attempts++
            ) {
                events = await voice.poll("alice", "1", id);
            }

            assert.ok(events.length <= 128);
            assert.ok(events.some((event) => event.type === "error"));
            assert.throws(() => voice.push("alice", "1", id, Buffer.alloc(2)), status(409));
        } finally {
            voice.close();
        }
    });
}

test("a 32000-byte accepted frame survives a smaller stdin high-water mark", async () => {
    const previous = getDefaultHighWaterMark(false);
    const voice = backend("silence");
    let id: string;

    try {
        setDefaultHighWaterMark(false, 16 * 1024);
        id = voice.start("alice", "1");
    } finally {
        setDefaultHighWaterMark(false, previous);
    }

    try {
        await voice.poll("alice", "1", id);
        voice.push("alice", "1", id, Buffer.alloc(32000));
        const events = await voice.poll("alice", "1", id);

        if (events.length === 1) {
            events.push(...(await voice.poll("alice", "1", id)));
        }

        assert.deepEqual(events, [
            { type: "interim", text: "silence" },
            { type: "final", text: "silence" },
        ]);
    } finally {
        voice.close();
    }
});

test("stalled native stdin rejects further PCM without killing the worker", async () => {
    const voice = backend("stalled");
    const id = voice.start("alice", "1");

    try {
        await voice.poll("alice", "1", id);
        let failed = false;

        for (let attempt = 0; attempt < 100; attempt++) {
            try {
                voice.push("alice", "1", id, Buffer.alloc(MAX_VOICE_PCM));
            } catch (error) {
                assert.ok(status(503)(error));
                failed = true;
                break;
            }
        }

        assert.ok(failed);
        assert.throws(() => voice.push("alice", "1", id, Buffer.alloc(2)), status(503));
        const controller = new AbortController();

        controller.abort();
        assert.deepEqual(await voice.poll("alice", "1", id, controller.signal), []);
    } finally {
        voice.close();
    }
});

test("missing executable reports asynchronous error; idle sessions expire", async () => {
    const voice = new VoiceSessions({
        workerPath: join(directory, "absent"),
        modelPath: "unused",
        pollMs: 1000,
    });
    const id = voice.start("alice", "1");

    try {
        assert.equal((await voice.poll("alice", "1", id))[0]?.type, "error");
    } finally {
        voice.close();
    }

    const idle = backend("normal", 300);
    const idleId = idle.start("alice", "1");

    try {
        await idle.poll("alice", "1", idleId);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await assert.rejects(idle.poll("alice", "1", idleId), status(404));
    } finally {
        idle.close();
    }
});

test("long poll times out empty", async () => {
    const voice = new VoiceSessions({ workerPath, modelPath: "normal", pollMs: 20 });
    const id = voice.start("alice", "1");

    try {
        for (let attempts = 0; attempts < 20; attempts++) {
            const events = await voice.poll("alice", "1", id);

            if (events.length) {
                assert.equal(events[0]?.type, "ready");
                break;
            }
        }

        assert.deepEqual(await voice.poll("alice", "1", id), []);
    } finally {
        voice.close();
    }
});

test("HTTP voice routes require sign-in, steer and visibility; reject cross-site and oversized PCM", async () => {
    const app = {
        config: {
            userByToken: (token: string) =>
                token === "valid" ? { id: "alice", role: "guest" } : undefined,
        },
        requireSee: (_user: unknown, id: number) => {
            if (id === 2) {
                throw new HttpError(403, "Hidden");
            }
        },
        requireSteer: () => {
            if (viewer) {
                throw new HttpError(403, "Read only");
            }
        },
    } as unknown as PocketApp;
    let viewer = false;
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart() {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/c`;
    const headers = {
        authorization: "Bearer valid",
        "content-type": "application/octet-stream",
        "x-pocket": "1",
    };

    try {
        assert.equal((await fetch(`${url}/1/voice`, { method: "POST" })).status, 401);
        assert.equal((await fetch(`${url}/2/voice/id`, { headers })).status, 403);
        viewer = true;
        assert.equal((await fetch(`${url}/1/voice/id`, { headers })).status, 403);
        viewer = false;
        assert.equal(
            (
                await fetch(`${url}/1/voice`, {
                    method: "POST",
                    headers: { ...headers, "sec-fetch-site": "cross-site" },
                })
            ).status,
            403,
        );
        assert.equal(
            (
                await fetch(`${url}/1/voice/id`, {
                    method: "POST",
                    headers,
                    body: Buffer.alloc(MAX_VOICE_PCM + 2),
                })
            ).status,
            413,
        );
        assert.equal(
            (
                await fetch(`${url}/1/voice/id`, {
                    method: "POST",
                    headers: { authorization: "Bearer valid", "x-pocket": "1" },
                    body: "x",
                })
            ).status,
            415,
        );
        assert.equal((await fetch(`${url}/1/voice/id`, { headers })).status, 404);
        assert.equal((await fetch(`${url}/1/voice/id/finish`, { headers })).status, 405);
        assert.equal(
            (await fetch(`${url}/1/voice/id/finish`, { method: "POST", headers })).status,
            404,
        );
        assert.equal(
            (await fetch(`${url}/2/voice/id/finish`, { method: "POST", headers })).status,
            403,
        );
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
});
