// Laptop "agent host": spawns N agents, one Web Worker each. Call from a client component.
import type { BrainKind } from "../brains";
import type { AgentStatus } from "./connection";
import { resolveServerUrl } from "./connection";
import type { WorkerCommand, WorkerEvent } from "./protocol";

export interface HostOptions {
    url?: string;
    count?: number;
    brain?: BrainKind;
    /** Callsign prefix; ids are `${prefix}-${n}` starting at 1 (Echo-1 ... Echo-8). */
    prefix?: string;
    seed?: number;
    onStatus?: (s: AgentStatus) => void;
}

export interface AgentHost {
    ids: string[];
    stop(): void;
}

export function spawnWorker(): Worker {
    return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

export function spawnAgentHost(opts: HostOptions = {}): AgentHost {
    const url = resolveServerUrl(opts.url);
    const count = opts.count ?? 8;
    const prefix = opts.prefix ?? "Echo";
    const workers: Worker[] = [];
    const ids: string[] = [];
    for (let n = 1; n <= count; n++) {
        const id = `${prefix}-${n}`;
        const w = spawnWorker();
        w.onmessage = (ev: MessageEvent<WorkerEvent>) => opts.onStatus?.(ev.data.status);
        const cmd: WorkerCommand = { type: "start", url, id, isPhone: false, brain: opts.brain ?? "hive", seed: opts.seed };
        w.postMessage(cmd);
        workers.push(w);
        ids.push(id);
    }
    return {
        ids,
        stop() {
            for (const w of workers) {
                w.postMessage({ type: "stop" } satisfies WorkerCommand);
                w.terminate();
            }
        },
    };
}
