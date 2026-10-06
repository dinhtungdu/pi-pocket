import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors.ts";

export const MAX_VOICE_PCM = 32 * 1024;
const MAX_EVENTS = 128;
const MAX_LINE = 16 * 1024;

export type VoiceEvent =
    | { type: "ready"; sampleRate: number }
    | { type: "interim" | "final"; text: string }
    | { type: "flushed" }
    | { type: "error"; message: string };

interface Session {
    id: string;
    user: string;
    conversation: string;
    child: ChildProcessWithoutNullStreams;
    ready: boolean;
    draining: boolean;
    stopped: boolean;
    output: string;
    queue: VoiceEvent[];
    expiry?: NodeJS.Timeout;
    wake?: () => void;
}

interface VoiceOptions {
    workerPath?: string;
    modelPath?: string;
    pollMs?: number;
    inactivityMs?: number;
}

function paths(): { workerPath: string; modelPath: string } {
    const home = join(homedir(), ".pi", "agent");
    let config: { sttWorkerPath?: unknown; sttModelPath?: unknown } = {};

    try {
        config = JSON.parse(readFileSync(join(home, "voice.json"), "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new HttpError(503, "Cannot read voice configuration");
        }
    }

    return {
        workerPath:
            typeof config?.sttWorkerPath === "string"
                ? config.sttWorkerPath
                : join(home, "cache/pi-voice/bin/pi-voice-stt"),
        modelPath:
            typeof config?.sttModelPath === "string"
                ? config.sttModelPath
                : join(home, "cache/pi-voice/models/parakeet/realtime_eou_120m-v1-q8_0.gguf"),
    };
}

/** Ephemeral dictation only: never submits a prompt or starts speech playback. */
export class VoiceSessions {
    private sessions = new Map<string, Session>();
    private options: VoiceOptions;

    constructor(options: VoiceOptions = {}) {
        this.options = options;
    }

    start(user: string, conversation: string): string {
        const configured =
            this.options.workerPath && this.options.modelPath ? this.options : paths();

        for (const session of this.sessions.values()) {
            if (session.user === user) {
                this.remove(session);
            }
        }

        const child = spawn(
            this.options.workerPath ?? configured.workerPath!,
            [this.options.modelPath ?? configured.modelPath!],
            { stdio: "pipe" },
        );
        const session: Session = {
            id: randomUUID(),
            user,
            conversation,
            child,
            ready: false,
            draining: false,
            stopped: false,
            output: "",
            queue: [],
        };

        this.sessions.set(session.id, session);
        this.touch(session);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => this.output(session, chunk));
        // Drain native diagnostic output without retaining an unbounded log.
        child.stderr.resume();
        child.stdin.on("error", () => this.fail(session, "STT input failed"));
        child.once("error", () => this.fail(session, "Unable to start STT worker"));
        child.once("close", () => this.fail(session, "STT worker exited"));

        return session.id;
    }

    private get(user: string, conversation: string, id: string): Session {
        const session = this.sessions.get(id);

        if (!session || session.user !== user || session.conversation !== conversation) {
            throw new HttpError(404, "No such voice session");
        }

        this.touch(session);

        return session;
    }

    private touch(session: Session): void {
        clearTimeout(session.expiry);
        session.expiry = setTimeout(
            () => this.remove(session),
            this.options.inactivityMs ?? 60_000,
        );
        session.expiry.unref();
    }

    private stop(session: Session): void {
        session.stopped = true;
        session.output = "";
        session.child.kill("SIGKILL");
    }

    private remove(session: Session): void {
        clearTimeout(session.expiry);
        this.sessions.delete(session.id);
        this.stop(session);
        session.wake?.();
    }

    private fail(session: Session, message: string): void {
        if (session.stopped) {
            return;
        }

        this.stop(session);
        // Keep a terminal error available to the next poll, even on queue overflow.
        session.queue = [{ type: "error", message }];
        session.wake?.();
    }

    private output(session: Session, chunk: string): void {
        if (session.stopped) {
            return;
        }

        session.output += chunk;
        let newline: number;

        while ((newline = session.output.indexOf("\n")) !== -1) {
            if (newline > MAX_LINE) {
                this.fail(session, "STT event too large");

                return;
            }

            const line = session.output.slice(0, newline).trim();

            session.output = session.output.slice(newline + 1);

            if (!line) {
                continue;
            }

            let event: VoiceEvent;

            try {
                const value = JSON.parse(line);

                if (value.type === "ready" && value.sampleRate === 16000) {
                    session.ready = true;
                    event = { type: "ready", sampleRate: 16000 };
                } else if (
                    (value.type === "interim" || value.type === "final") &&
                    typeof value.text === "string"
                ) {
                    event = { type: value.type, text: value.text };
                } else if (value.type === "error" && typeof value.message === "string") {
                    this.fail(session, value.message);

                    return;
                } else if (value.type === "reset" && session.draining) {
                    event = { type: "flushed" };
                } else if (value.type === "reset" || value.type === "backchannel") {
                    continue;
                } else {
                    throw new Error("Invalid event");
                }
            } catch {
                this.fail(session, "Invalid STT event");

                return;
            }

            if (session.queue.length >= MAX_EVENTS) {
                this.fail(session, "STT event queue full");

                return;
            }

            session.queue.push(event);
            session.wake?.();
        }

        if (session.output.length > MAX_LINE) {
            this.fail(session, "STT event too large");
        }
    }

    push(user: string, conversation: string, id: string, pcm: Buffer): void {
        const session = this.get(user, conversation, id);

        if (!pcm.length || pcm.length > MAX_VOICE_PCM || pcm.length % 2 !== 0) {
            throw new HttpError(
                pcm.length > MAX_VOICE_PCM ? 413 : 400,
                "Expected PCM16LE mono 16kHz, 1–32768 bytes, even length",
            );
        }

        if (session.stopped || !session.ready || session.draining) {
            throw new HttpError(409, "STT worker is not ready");
        }

        const input = session.child.stdin;

        if (!input.writable || input.destroyed || input.writableEnded) {
            this.fail(session, "STT input closed");

            throw new HttpError(503, "STT input closed");
        }

        if (input.writableNeedDrain || input.writableLength > 0) {
            throw new HttpError(503, "STT input backpressure");
        }

        const frame = Buffer.allocUnsafe(5 + pcm.length);

        frame[0] = 1;
        frame.writeUInt32LE(pcm.length, 1);
        pcm.copy(frame, 5);

        // False still means accepted: let this bounded frame drain before accepting another.
        input.write(frame);
    }

    /** Reset is acknowledged after the native worker has consumed every preceding PCM frame. */
    finish(user: string, conversation: string, id: string): void {
        const session = this.get(user, conversation, id);
        const input = session.child.stdin;

        if (session.stopped || !session.ready || session.draining) {
            throw new HttpError(409, "STT worker is not ready");
        }

        if (!input.writable || input.destroyed || input.writableEnded || input.writableNeedDrain) {
            throw new HttpError(503, "STT input backpressure");
        }

        session.draining = true;
        input.write(Buffer.from([2, 0, 0, 0, 0]));
    }

    async poll(
        user: string,
        conversation: string,
        id: string,
        signal?: AbortSignal,
    ): Promise<VoiceEvent[]> {
        const session = this.get(user, conversation, id);

        if (session.wake) {
            throw new HttpError(409, "Voice poll already pending");
        }

        if (!session.queue.length && !session.stopped && !signal?.aborted) {
            await new Promise<void>((resolve) => {
                const wake = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", wake);
                    session.wake = undefined;
                    resolve();
                };

                const timer = setTimeout(wake, Math.min(this.options.pollMs ?? 15_000, 15_000));

                session.wake = wake;
                signal?.addEventListener("abort", wake, { once: true });
            });
        }

        return signal?.aborted ? [] : session.queue.splice(0);
    }

    delete(user: string, conversation: string, id: string): void {
        this.remove(this.get(user, conversation, id));
    }

    close(): void {
        for (const session of this.sessions.values()) {
            this.remove(session);
        }
    }
}
