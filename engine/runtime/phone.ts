// Phone agent: same brain in a Web Worker, plus a stable callsign and a screen Wake Lock.
import type { BrainKind } from "../brains";
import type { AgentStatus } from "./connection";
import { resolveServerUrl } from "./connection";
import { spawnWorker } from "./host";
import type { WorkerCommand, WorkerEvent } from "./protocol";

const ID_KEY = "hive.agentId";

export interface PhoneOptions {
    url?: string;
    brain?: BrainKind;
    onStatus?: (s: AgentStatus) => void;
}

export interface PhoneAgent {
    id: string;
    stop(): void;
}

/** Stable callsign across reloads/reconnects, e.g. "Echo-47" (10-99 to avoid laptop agents 1-8). */
export function phoneCallsign(): string {
    try {
        const saved = localStorage.getItem(ID_KEY);
        if (saved) {
            return saved;
        }
    } catch {
        // storage blocked: fall through to a fresh id
    }
    const id = `Echo-${10 + Math.floor(Math.random() * 90)}`;
    try {
        localStorage.setItem(ID_KEY, id);
    } catch {
        // ignore
    }
    return id;
}

type WakeLockLike = { release(): Promise<void> };

async function keepAwake(): Promise<() => void> {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockLike> } };
    if (!nav.wakeLock) {
        return () => {};
    }
    let lock: WakeLockLike | null = null;
    const acquire = async () => {
        try {
            lock = await nav.wakeLock!.request("screen");
        } catch {
            lock = null;
        }
    };
    const onVisible = () => {
        if (document.visibilityState === "visible") {
            void acquire();
        }
    };
    await acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
        document.removeEventListener("visibilitychange", onVisible);
        void lock?.release();
    };
}

/** Call from a user gesture (button tap) so the Wake Lock is granted. */
export async function startPhoneAgent(opts: PhoneOptions = {}): Promise<PhoneAgent> {
    const id = phoneCallsign();
    const release = await keepAwake();
    const w = spawnWorker();
    w.onmessage = (ev: MessageEvent<WorkerEvent>) => opts.onStatus?.(ev.data.status);
    const cmd: WorkerCommand = { type: "start", url: resolveServerUrl(opts.url), id, isPhone: true, brain: opts.brain ?? "hive" };
    w.postMessage(cmd);
    return {
        id,
        stop() {
            w.postMessage({ type: "stop" } satisfies WorkerCommand);
            w.terminate();
            release();
        },
    };
}
