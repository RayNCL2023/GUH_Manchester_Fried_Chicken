// Web Worker entry: runs one agent brain + its WebSocket connection off the main thread.
import { createBrain } from "../brains";
import { connectAgent, type AgentConnection } from "./connection";
import type { WorkerCommand, WorkerEvent } from "./protocol";

const ctx = self as unknown as {
    postMessage(msg: WorkerEvent): void;
    onmessage: ((ev: MessageEvent<WorkerCommand>) => void) | null;
};

let conn: AgentConnection | null = null;

ctx.onmessage = (ev) => {
    const cmd = ev.data;
    if (cmd.type === "stop") {
        conn?.close();
        conn = null;
        return;
    }
    if (conn) {
        return;
    }
    conn = connectAgent({
        url: cmd.url,
        id: cmd.id,
        isPhone: cmd.isPhone,
        makeBrain: () => createBrain(cmd.brain, { width: cmd.width, height: cmd.height, seed: cmd.seed }),
        onStatus: (status) => ctx.postMessage({ type: "status", status }),
    });
};
