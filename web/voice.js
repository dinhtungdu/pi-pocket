import { useEffect, useRef, useState } from "preact/hooks";
import { notify } from "./store.js";
import { html, Icon, Spinner } from "./ui.js";
import { VoiceInput } from "./voice-input.js";

/** Stop prepares an editable draft; Send finishes dictation before submitting that draft. */
export function VoiceButton({ conversationId, onText, onInterim, onState, onSend, sendDisabled }) {
    const [phase, setPhase] = useState("off");
    const voice = useRef(null);
    const callbacks = useRef(null);
    const mounted = useRef(true);

    callbacks.current = { onText, onInterim, onState, onSend };

    const changePhase = (state) => {
        setPhase(state);
        callbacks.current.onState(state);
    };

    useEffect(() => {
        mounted.current = true;

        const hide = () => {
            if (document.hidden) {
                voice.current?.close();
                voice.current = null;
                changePhase("off");
                callbacks.current.onInterim("");
            }
        };

        document.addEventListener("visibilitychange", hide);

        return () => {
            mounted.current = false;
            document.removeEventListener("visibilitychange", hide);
            voice.current?.close();
            callbacks.current.onState("off");
            callbacks.current.onInterim("");
        };
    }, []);

    const finish = async (send) => {
        const input = voice.current;

        if (!input || phase === "finishing") {
            return;
        }

        const completed = await input.stop();

        if (send && completed) {
            // The final transcript can update the composer in stop(); send its latest render, not the old draft.
            await new Promise((resolve) => requestAnimationFrame(resolve));

            if (mounted.current && !document.hidden && !voice.current) {
                callbacks.current.onSend();
            }
        }
    };

    const start = () => {
        if (voice.current) {
            return;
        }

        changePhase("starting");
        const input = new VoiceInput(conversationId, {
            onState: (state) => {
                changePhase(state);

                if (state === "off") {
                    voice.current = null;
                }
            },
            onInterim: (text) => callbacks.current.onInterim(text),
            onText: (text) => callbacks.current.onText(text),
            onError: (message) => {
                voice.current = null;
                changePhase("off");
                callbacks.current.onInterim("");
                notify("error", message);
            },
        });

        voice.current = input;
        void input.start();
    };

    if (phase === "off") {
        return html`<button
            class="icon-button"
            aria-label="Start voice input"
            title="Dictate with local Parakeet"
            onClick=${start}
        >
            <${Icon} name="mic" />
        </button>`;
    }

    return html`<span class="muted small" role="status">
        ${phase === "starting" ? "Starting…" : phase === "finishing" ? "Transcribing…" : "Listening…"}
    </span>
    <button
        class="round stop"
        aria-label="Stop recording and edit transcription"
        title="Stop recording; review the draft before sending"
        disabled=${phase === "finishing"}
        onClick=${() => finish(false)}
    >
        <${Icon} name="stop" size=${16} />
    </button>
    <button
        class="round send"
        aria-label="Send recording"
        title="Finish transcription and send to Pi"
        disabled=${phase !== "listening" || sendDisabled}
        onClick=${() => finish(true)}
    >
        ${phase === "finishing" ? html`<${Spinner} />` : html`<${Icon} name="send" size=${18} />`}
    </button>`;
}
