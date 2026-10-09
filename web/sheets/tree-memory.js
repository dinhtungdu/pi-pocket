// Per-conversation memory; settings permissions and server-pushed preparation status.
import { actions, attempt, canSteer, closeSheet, store } from "../store.js";
import { useEffect, useState } from "preact/hooks";
import { html, Sheet, Switch } from "../ui.js";

export function TreeMemorySheet() {
    const { view, me, models } = store.state;
    const memory = view.treeMemory;
    const [busy, setBusy] = useState(false);
    const driving = !view.turns?.on || view.turns.driver === me?.id;
    const savedModel = memory?.model ?? { provider: "openai-codex", modelId: "gpt-6-luna" };
    const savedKey = `${savedModel.provider}/${savedModel.modelId}`;
    const savedLevel = memory?.thinkingLevel ?? "high";
    const [selection, setSelection] = useState(savedKey);
    const [level, setLevel] = useState(savedLevel);
    const selected = models.find((model) => `${model.provider}/${model.id}` === selection);
    const levels = selected?.levels ?? [];
    const editable =
        !busy && canSteer() && driving && memory?.available && memory?.model !== undefined;

    useEffect(() => {
        setSelection(savedKey);
        setLevel(savedLevel);
    }, [view.id, savedKey, savedLevel]);
    const status = !memory?.enabled
        ? "Off"
        : !memory.available
          ? "Off — extension unavailable"
          : memory.phase === "ready"
            ? "Active"
            : memory.phase === "error" || memory.error
              ? "Error"
              : "Preparing";

    return html`<${Sheet} title="Tree memory" onClose=${closeSheet}>
        <div class="setting-row">
            <div class="setting-text">
                <span>Tree memory</span>
                <span role="status">${status}</span>
            </div>
            <${Switch}
                label="Tree memory"
                on=${memory?.enabled ?? false}
                disabled=${busy || !canSteer() || !driving || (!memory?.available && !memory?.enabled)}
                onChange=${() =>
                    attempt(async () => {
                        setBusy(true);

                        try {
                            await actions.treeMemory(!memory.enabled);
                        } finally {
                            setBusy(false);
                        }
                    })}
            />
        </div>
        <div class="setting-row">
            <div class="setting-text">
                <label for="compressor-model">Compressor model</label>
                <select
                    id="compressor-model"
                    aria-label="Compressor model"
                    value=${selection}
                    disabled=${!editable}
                    onChange=${(event) => {
                        const value = event.currentTarget.value;
                        const model = models.find(
                            (item) => `${item.provider}/${item.id}` === value,
                        );

                        setSelection(value);

                        if (!model.levels.includes(level)) {
                            setLevel(model.levels[0]);
                        }
                    }}
                >
                    ${!selected && html`<option value=${selection} disabled>${selection} (unavailable)</option>`}
                    ${models.map((model) => html`<option value=${`${model.provider}/${model.id}`}>${model.name} · ${model.provider}</option>`)}
                </select>
            </div>
        </div>
        <div class="setting-row">
            <div class="setting-text">
                <label for="compressor-thinking">Compressor thinking</label>
                <select
                    id="compressor-thinking"
                    aria-label="Compressor thinking"
                    value=${level}
                    disabled=${!editable || !selected}
                    onChange=${(event) => setLevel(event.currentTarget.value)}
                >
                    ${!levels.includes(level) && html`<option value=${level} disabled>${level} (unavailable)</option>`}
                    ${levels.map((value) => html`<option value=${value}>${value}</option>`)}
                </select>
            </div>
        </div>
        ${memory?.available && !memory.model && html`<p class="muted small">Compressor controls require the checked server update; current settings remain unchanged.</p>`}
        ${!selected && html`<p role="alert">${selection} is unavailable. Add its provider or choose an available model; no model will be substituted automatically.</p>`}
        <button
            disabled=${!editable || !selected || !levels.includes(level) || (selection === savedKey && level === savedLevel)}
            onClick=${() =>
                attempt(async () => {
                    setBusy(true);

                    try {
                        await actions.configureTreeMemory({
                            model: { provider: selected.provider, modelId: selected.id },
                            thinkingLevel: level,
                        });
                    } finally {
                        setBusy(false);
                    }
                })}
        >Save compressor</button>
        <p class="muted small">Model and thinking changes apply to future summaries only. Existing nodes remain unchanged; in-flight requests keep their original settings. Default: Luna/high. Compression costs model calls.</p>
        <p class="muted small">Keeps bounded summaries; original messages remain in history and zoom. Enabling backfills this conversation’s visible history, including inherited fork history.</p>
        <p class="muted small">Preparation starts on the next user input. Long initial backfills continue in one bounded background task; compressor failures pause. Native context stays until ready; after activation, errors stop generation instead of dropping history. Disable to restore native context. New context starts a fresh memory epoch; forks opt in independently.</p>
        ${memory?.enabled && html`<p class="muted small">${memory.count} original spans · ${memory.pending} queued nodes</p>`}
        ${memory?.error && html`<p role="alert">${memory.error}</p>`}
        ${
            memory?.enabled &&
            memory.phase === "warming" &&
            memory.error &&
            html`
            <button
                disabled=${busy || !canSteer() || !driving || !memory.available}
                onClick=${() =>
                    attempt(async () => {
                        setBusy(true);

                        try {
                            await actions.treeMemory(true);
                        } finally {
                            setBusy(false);
                        }
                    })}
            >Resume preparation</button>
        `
        }
        ${!memory?.available && html`<p class="muted small">The owner must enable the Tree memory extension in Extensions first.</p>`}
        ${!canSteer() && html`<p class="muted small">Viewers cannot change Pi’s settings.</p>`}
        ${canSteer() && !driving && html`<p class="muted small">Take the wheel first to change this setting.</p>`}
    <//>`;
}
