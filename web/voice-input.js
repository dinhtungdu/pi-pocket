// A microphone belongs to this browser, not the server. Only PCM goes to the local STT worker.
export class VoiceInput {
    constructor(conversationId, callbacks) {
        this.base = `/api/c/${conversationId}/voice`;
        this.callbacks = callbacks;
        this.abort = new AbortController();
        this.chunks = [];
        this.bytes = 0;
        this.uploading = false;
        this.closed = false;
        this.interim = "";
    }

    async request(url, options = {}, controller = this.abort) {
        const timeout = setTimeout(() => controller.abort(), 20000);

        try {
            const response = await fetch(url, {
                ...options,
                headers: { "X-Pocket": "1", ...options.headers },
                signal: controller.signal,
            });
            const body = await response.json();

            if (!response.ok) {
                throw new Error(body.error ?? "Voice input failed");
            }

            return body;
        } finally {
            clearTimeout(timeout);
        }
    }

    async start() {
        try {
            if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
                throw new Error("Voice input needs HTTPS (or localhost) and microphone support.");
            }

            // Resume inside the tap, before permission prompts can consume mobile's user gesture.
            this.context = new AudioContext({ sampleRate: 16000 });
            await this.context.resume();
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
            });

            if (this.closed) {
                this.releaseAudio();

                return;
            }

            for (const track of this.stream.getTracks()) {
                track.onended = () => this.fail(new Error("Microphone disconnected"));
            }

            await this.context.audioWorklet.addModule("/voice-worklet.js");

            if (this.closed) {
                return;
            }

            // A cancelled creation still needs its id so we can delete the server's worker.
            const { id } = await this.request(this.base, { method: "POST" }, new AbortController());

            this.url = `${this.base}/${encodeURIComponent(id)}`;

            if (this.closed) {
                this.deleteSession();

                return;
            }

            this.readyTimeout = setTimeout(
                () => this.fail(new Error("Parakeet did not become ready. Try again.")),
                30000,
            );
            this.poll();
        } catch (error) {
            this.fail(error);
        }
    }

    capture() {
        clearTimeout(this.readyTimeout);
        this.source = this.context.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(this.context, "voice-capture", {
            channelCount: 1,
            channelCountMode: "explicit",
        });

        this.node.port.onmessage = ({ data }) => {
            if (this.closed || this.finishing) {
                return;
            }

            this.chunks.push(new Uint8Array(data));
            this.bytes += data.byteLength;

            if (this.bytes > 32000) {
                this.fail(new Error("Voice connection too slow. Try again."));
            } else if (this.bytes >= 8000) {
                void this.upload().catch((error) => this.fail(error));
            }
        };

        // The processor outputs silence; connecting it keeps capture running on mobile.
        this.source.connect(this.node);
        this.node.connect(this.context.destination);
        this.callbacks.onState("listening");
    }

    async poll() {
        try {
            while (!this.closed) {
                const { events } = await this.request(this.url);

                for (const event of events) {
                    if (this.closed) {
                        return;
                    }

                    if (event.type === "error") {
                        throw new Error(event.message);
                    }

                    if (event.type === "ready" && !this.node && !this.finishing) {
                        this.capture();
                    }

                    if (event.type === "interim") {
                        this.interim = event.text;
                        this.callbacks.onInterim(event.text);
                    }

                    if (event.type === "final") {
                        this.interim = "";
                        this.callbacks.onInterim("");
                        this.callbacks.onText(event.text);
                    }

                    if (event.type === "flushed") {
                        this.finishResolve?.(true);
                    }
                }
            }
        } catch (error) {
            this.fail(error);
        }
    }

    async upload() {
        if (this.uploading || this.closed) {
            return;
        }

        this.uploading = true;

        try {
            while (this.bytes > 0 && !this.closed) {
                const pcm = new Uint8Array(this.bytes);
                let offset = 0;

                for (const chunk of this.chunks) {
                    pcm.set(chunk, offset);
                    offset += chunk.length;
                }

                this.chunks = [];
                this.bytes = 0;
                await this.request(this.url, {
                    method: "POST",
                    headers: { "content-type": "application/octet-stream" },
                    body: pcm,
                });
            }
        } finally {
            this.uploading = false;
        }
    }

    releaseAudio() {
        for (const track of this.stream?.getTracks() ?? []) {
            track.onended = null;
            track.stop();
        }

        this.source?.disconnect();
        this.node?.disconnect();

        if (this.node) {
            this.node.port.onmessage = null;
        }

        void this.context?.close().catch(() => {});
    }

    async stop() {
        if (this.closed || this.finishing) {
            return false;
        }

        this.finishing = true;
        this.callbacks.onState("finishing");
        this.releaseAudio();

        if (!this.url || !this.node) {
            this.close();
            this.callbacks.onState("off");

            return false;
        }

        try {
            // Silence gives Parakeet a chance to finalize the last phrase after the mic stops.
            while (this.uploading && !this.closed) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }

            await this.upload();
            const finalized = new Promise((resolve) => {
                this.finishResolve = resolve;
            });

            // The installed EOU model needs more than one second of trailing silence to emit final.
            for (let i = 0; i < 3; i++) {
                await this.request(this.url, {
                    method: "POST",
                    headers: { "content-type": "application/octet-stream" },
                    body: new Uint8Array(32000),
                });
                await new Promise((resolve) => setTimeout(resolve, 100));
            }

            await this.request(`${this.url}/finish`, { method: "POST" });
            this.finishTimeout = setTimeout(() => this.finishResolve?.(false), 8000);
            const completed = await finalized;

            clearTimeout(this.finishTimeout);
            this.finishResolve = null;

            if (this.closed) {
                return false;
            }

            if (this.interim) {
                this.callbacks.onText(this.interim);
            }

            this.callbacks.onInterim("");
            this.close();
            this.callbacks.onState("off");

            if (!completed) {
                this.callbacks.onError(
                    "Transcription did not finish. Review the draft and send manually.",
                );
            }

            return completed;
        } catch (error) {
            this.fail(error);

            return false;
        }
    }

    deleteSession() {
        if (this.url) {
            void fetch(this.url, {
                method: "DELETE",
                headers: { "X-Pocket": "1" },
                keepalive: true,
            }).catch(() => {});
        }
    }

    close() {
        if (this.closed) {
            return;
        }

        this.closed = true;
        clearTimeout(this.readyTimeout);
        clearTimeout(this.finishTimeout);
        this.finishResolve?.(false);
        this.releaseAudio();
        this.abort.abort();
        this.deleteSession();
    }

    fail(error) {
        if (this.closed) {
            return;
        }

        this.close();
        this.callbacks.onError(error.message ?? String(error));
    }
}
