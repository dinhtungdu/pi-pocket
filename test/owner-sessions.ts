// Optional owner extension: exercise its installed source through Pocket's native loader, not a built-in copy.
import { openApp as openCoreApp, root } from "./helpers.ts";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test as nativeTest } from "node:test";
import { ConfigStore } from "../src/server/config.ts";

export const sessionsSource =
    process.env.PI_POCKET_SESSIONS_EXTENSION ??
    join(homedir(), ".pi-pocket/extensions/sessions.ts");

const installed = existsSync(sessionsSource);

if (process.env.PI_POCKET_SESSIONS_EXTENSION !== undefined && !installed) {
    throw new Error(`Configured sessions extension is missing: ${sessionsSource}`);
}

// Only wrapper integration tests skip without the optional module; core service tests still run.
export const test = installed ? nativeTest : nativeTest.skip;

export async function openApp(...args: Parameters<typeof openCoreApp>) {
    const [model, dataDir = join(root, "data"), now] = args;

    if (!installed) {
        return openCoreApp(model, dataDir, now);
    }

    const directory = join(dataDir, "extensions");

    mkdirSync(directory, { recursive: true });
    copyFileSync(sessionsSource, join(directory, "sessions.ts"));

    const config = new ConfigStore(dataDir);

    if (config.extensionChoice("sessions.ts") === undefined) {
        config.setExtensionEnabled("sessions.ts", true);
    }

    return openCoreApp(model, dataDir, now);
}
