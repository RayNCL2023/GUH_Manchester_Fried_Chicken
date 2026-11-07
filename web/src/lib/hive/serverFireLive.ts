"use client";

// Firebreak backed by the real world server (drones are separate processes: laptop workers,
// phones, or server bots). If the server is unreachable, it transparently runs the in-browser
// sim instead, so the demo survives a dead venue wifi.
import type { Control, Vec, WorldView } from "../../../../shared/types";
import FireLive, { type FireSnap } from "./fireLive";
import { bearing } from "./pixel";
import { ViewerSocket } from "./server";
import type { Chatter, Live } from "./types";

export type SourcedSnap = FireSnap & { source: "server" | "sim" };

export default class ServerFireLive implements Live<SourcedSnap> {
    private socket: ViewerSocket;
    private local: FireLive | null = null;
    private history: number[] = [];
    private lastHistTick = -1;
    private goalSeq = 0;
    /** Slider shows the setting; the stats strip shows measured loss. */
    private lossSetting = 0;
    private readonly startedAt = performance.now();

    constructor(url: string, private readonly scenario: "fire" | "lights" = "fire") {
        this.socket = new ViewerSocket(url);
        this.socket.control({ type: "switchScenario", scenario });
        setTimeout(() => this.ensureScenario(), 600);
    }

    private ensureScenario() {
        if (this.socket.view && this.socket.view.scenario !== this.scenario) {
            this.socket.control({ type: "switchScenario", scenario: this.scenario });
        }
    }

    /** Server if it's talking to us; local sim after 3 s of silence. */
    private get useServer(): boolean {
        if (this.socket.connected) {
            return true;
        }
        return performance.now() - this.startedAt < 3000 && !this.local;
    }

    step() {
        if (this.useServer) {
            this.ensureScenarioOnce();
            return;
        }
        this.local ??= new FireLive();
        this.local.step();
    }

    private checked = false;
    private ensureScenarioOnce() {
        if (this.checked || !this.socket.view) {
            return;
        }
        this.checked = true;
        this.ensureScenario();
    }

    control(c: Control) {
        if (c.type === "setLoss") {
            this.lossSetting = c.pct;
        }
        if (c.type === "reset") {
            this.lossSetting = 0;
        }
        if (this.useServer) {
            this.socket.control(c);
            return;
        }
        this.local?.control(c);
    }

    rotateWind() {
        if (!this.useServer) {
            this.local?.rotateWind();
            return;
        }
        const w = this.socket.view?.wind ?? { x: 1, y: 0 };
        const a = Math.atan2(w.y, w.x) + Math.PI / 4;
        const m = Math.hypot(w.x, w.y) || 1;
        this.socket.control({ type: "setWind", wind: { x: Math.cos(a) * m, y: Math.sin(a) * m } });
    }

    villageCentre(): Vec | null {
        const v = this.useServer ? this.socket.view : this.local?.snapshot().view;
        if (!v) {
            return null;
        }
        let x = 0;
        let y = 0;
        let n = 0;
        v.cells.forEach((c, i) => {
            if (c === "village") {
                x += i % v.width;
                y += Math.floor(i / v.width);
                n++;
            }
        });
        return n ? { x: x / n, y: y / n } : null;
    }

    protectVillage() {
        if (!this.useServer) {
            this.local?.protectVillage();
            return;
        }
        const target = this.villageCentre() ?? undefined;
        this.socket.control({
            type: "goal",
            body: { id: `goal-ui-${Date.now()}-${++this.goalSeq}`, text: "Protect the village", target, radius: 8, priority: 3 },
        });
    }

    get isServer(): boolean {
        return this.useServer && !!this.socket.view;
    }

    snapshot(): SourcedSnap {
        if (!this.useServer || !this.socket.view) {
            this.local ??= new FireLive();
            return { ...this.local.snapshot(), source: "sim" };
        }
        const v: WorldView = this.socket.view;
        if (v.tick < this.lastHistTick) {
            this.history = [];
        }
        if (v.tick % 5 === 0 && v.tick !== this.lastHistTick) {
            this.lastHistTick = v.tick;
            this.history.push(Math.round(v.metrics.edgeMappedPct));
            if (this.history.length > 150) {
                this.history.shift();
            }
        }
        const alive = v.agents.filter((a) => a.alive);
        const phones = v.agents.filter((a) => a.isPhone).length;
        const isolated = alive.filter((a) => a.mode === "isolated").length;
        const chatter: Chatter[] = v.recentChatter.slice(-8).reverse();
        const burning = v.cells.filter((c) => c === "fire").length;
        return {
            source: "server",
            view: {
                ...v,
                metrics: { ...v.metrics, msgLossPct: this.lossSetting },
                agents: v.agents.map((a) => ({ ...a, knownPct: Math.round(a.knownPct), mode: a.alive ? a.mode : "down" })),
            },
            headline: Math.round(v.metrics.edgeMappedPct),
            history: [...this.history],
            chatter,
            stats: [
                { label: "Elapsed", value: Math.floor(v.tick / 10), unit: "s" },
                { label: "Flock alive", value: alive.length, unit: `/ ${v.agents.length}` },
                { label: "Phones", value: phones },
                { label: "Isolated", value: isolated },
                { label: "Radio links", value: v.links.length },
                { label: "Measured loss", value: Math.round(v.metrics.msgLossPct), unit: "%" },
                { label: "Wind bearing", value: bearing(v.wind), unit: "°" },
                { label: "Burning cells", value: burning },
            ],
        };
    }

    /** Raw WorldView for the radio player (server or local). */
    rawView(): WorldView | null {
        return this.useServer ? this.socket.view : (this.local?.snapshot().view ?? null);
    }

    close() {
        this.socket.close();
    }
}
