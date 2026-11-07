// One agent <-> world server over WebSocket. Works in a Web Worker or on the main thread.
import type { AgentBrain, AgentId, AgentToServer, ClientHello, ScenarioId, ServerToAgent } from "../../shared/types";

export interface AgentStatus {
    id: AgentId;
    connected: boolean;
    tick: number;
    scenario: ScenarioId | null;
    mode: string;
    claim: string | null;
    knownPct: number;
    color?: string;
    alive: boolean;
    jammed: boolean;
}

export interface ConnectOptions {
    url: string;
    id: AgentId;
    isPhone: boolean;
    makeBrain: () => AgentBrain;
    onStatus?: (s: AgentStatus) => void;
    /** Status callback every N ticks (default 5); always fires on connect/disconnect. */
    statusEvery?: number;
}

export interface AgentConnection {
    close(): void;
}

/** Resolve the server WebSocket URL: explicit > globalThis.HIVE_SERVER_URL > same host at /ws. */
export function resolveServerUrl(explicit?: string): string {
    if (explicit) {
        return explicit;
    }
    const g = globalThis as { HIVE_SERVER_URL?: string; location?: Location };
    if (g.HIVE_SERVER_URL) {
        return g.HIVE_SERVER_URL;
    }
    if (!g.location) {
        return "ws://localhost:3000/ws";
    }
    const proto = g.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${g.location.host}/ws`;
}

export function connectAgent(opts: ConnectOptions): AgentConnection {
    const statusEvery = opts.statusEvery ?? 5;
    let ws: WebSocket | null = null;
    let closed = false;
    let backoff = 500;
    let brain: AgentBrain | null = null;
    let scenario: ScenarioId | null = null;
    let lastTick = -1;
    const status: AgentStatus = {
        id: opts.id,
        connected: false,
        tick: 0,
        scenario: null,
        mode: "normal",
        claim: null,
        knownPct: 0,
        alive: true,
        jammed: false,
    };

    const report = () => opts.onStatus?.({ ...status });

    const open = () => {
        if (closed) {
            return;
        }
        ws = new WebSocket(opts.url);
        ws.onopen = () => {
            backoff = 500;
            const hello: ClientHello = { role: "agent", id: opts.id, isPhone: opts.isPhone };
            ws?.send(JSON.stringify(hello));
            status.connected = true;
            report();
        };
        ws.onmessage = (ev) => onMessage(ev.data);
        ws.onclose = () => {
            status.connected = false;
            report();
            if (closed) {
                return;
            }
            setTimeout(open, backoff);
            backoff = Math.min(backoff * 2, 5000);
        };
        ws.onerror = () => ws?.close();
    };

    const onMessage = (data: unknown) => {
        if (typeof data !== "string") {
            return;
        }
        let msg: ServerToAgent;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }
        if (msg.t !== "sense") {
            return;
        }
        const sense = msg.sense;
        // New brain on first sense, scenario switch, or server reset (tick went backwards).
        if (!brain || sense.scenario !== scenario || sense.tick < lastTick) {
            brain = opts.makeBrain();
            brain.init(opts.id, sense.scenario);
            scenario = sense.scenario;
        }
        lastTick = sense.tick;
        let out: AgentToServer;
        try {
            out = { t: "action", action: brain.step(sense) };
        } catch (err) {
            console.error(`[${opts.id}] brain.step failed`, err);
            out = { t: "action", action: {} };
        }
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(out));
        }
        status.tick = sense.tick;
        status.scenario = sense.scenario;
        status.alive = sense.self.alive;
        status.jammed = sense.self.jammed;
        status.claim = out.action.claimed ?? null;
        status.mode = out.action.status?.mode ?? status.mode;
        status.knownPct = out.action.status?.knownPct ?? status.knownPct;
        status.color = out.action.display?.color ?? status.color;
        if (sense.tick % statusEvery === 0 || out.action.display) {
            report();
        }
    };

    open();

    return {
        close() {
            closed = true;
            ws?.close();
        },
    };
}
