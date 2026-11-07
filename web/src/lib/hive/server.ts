"use client";

// Connection to the Hive world server. URL comes from ?server=… (remembered), else
// NEXT_PUBLIC_HIVE_SERVER, else none (pages fall back to the in-browser sim).
import type { CellState, Control, ServerToViewer, WorldView } from "../../../../shared/types";

const KEY = "hive.server";

export function serverUrl(): string | null {
    if (typeof window === "undefined") {
        return null;
    }
    const q = new URLSearchParams(window.location.search).get("server");
    if (q !== null) {
        try {
            if (q === "" || q === "off") {
                localStorage.removeItem(KEY);
                return null;
            }
            localStorage.setItem(KEY, q);
        } catch {
            // storage blocked
        }
        return toWs(q);
    }
    try {
        const saved = localStorage.getItem(KEY);
        if (saved) {
            return toWs(saved);
        }
    } catch {
        // storage blocked
    }
    const env = process.env.NEXT_PUBLIC_HIVE_SERVER;
    return env ? toWs(env) : null;
}

/** Accepts "hive.up.railway.app", "https://…", "wss://…/ws" or "localhost:3000". */
export function toWs(s: string): string {
    let u = s.trim().replace(/\/$/, "");
    if (!/^[a-z]+:\/\//.test(u)) {
        u = (/^(localhost|127\.|192\.168\.|10\.)/.test(u) ? "ws://" : "wss://") + u;
    }
    u = u.replace(/^http/, "ws");
    return u.endsWith("/ws") ? u : `${u}/ws`;
}

export function httpBase(ws: string): string {
    return ws.replace(/^ws/, "http").replace(/\/ws$/, "");
}

/** Query-string suffix that carries the server to other pages (QR code, /join). */
export function serverQuery(): string {
    const u = serverUrl();
    return u ? `?server=${encodeURIComponent(httpBase(u).replace(/^https?:\/\//, ""))}` : "";
}

/** Viewer socket: keeps a full grid from full frames + diffs; reconnects. */
export class ViewerSocket {
    view: WorldView | null = null;
    lastViewAt = 0;
    private ws: WebSocket | null = null;
    private grid: CellState[] = [];
    private closed = false;
    private backoff = 500;

    constructor(readonly url: string, private onView?: (v: WorldView) => void) {
        this.open();
    }

    get connected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN && performance.now() - this.lastViewAt < 3000;
    }

    private open() {
        if (this.closed) {
            return;
        }
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.onopen = () => {
            this.backoff = 500;
            ws.send(JSON.stringify({ role: "viewer" }));
        };
        ws.onmessage = (e) => {
            let m: ServerToViewer;
            try {
                m = JSON.parse(e.data);
            } catch {
                return;
            }
            if (m.t !== "view") {
                return;
            }
            const v = m.view;
            if (v.cells.length) {
                this.grid = v.cells.slice();
            } else {
                for (const [i, s] of v.cellDiff ?? []) {
                    this.grid[i] = s;
                }
            }
            this.view = { ...v, cells: this.grid };
            this.lastViewAt = performance.now();
            this.onView?.(this.view);
        };
        ws.onclose = () => {
            if (this.closed) {
                return;
            }
            setTimeout(() => this.open(), this.backoff);
            this.backoff = Math.min(this.backoff * 2, 5000);
        };
        ws.onerror = () => ws.close();
    }

    control(c: Control) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ t: "control", control: c }));
        }
    }

    close() {
        this.closed = true;
        this.ws?.close();
    }
}
