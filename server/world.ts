// World server core: 10 Hz tick, radio simulation, scenario plumbing, controls, WorldView.
// Transport-agnostic: agents/viewers are plain callbacks, so it runs under Bun.serve or in tests.
import type {
    Action,
    AgentId,
    CellState,
    Control,
    GoalBody,
    Msg,
    ScenarioId,
    Sense,
    ServerToAgent,
    ServerToViewer,
    Vec,
    WorldView,
} from "../shared/types";
import { dist, mulberry32, type Rng } from "../engine/util";
import { createFireScenario } from "./scenarios/fire";
import { createLightsScenario } from "./scenarios/lights";
import type { Scenario } from "./scenarios/types";
import type { WorldBrief } from "../ai";

export interface WorldConfig {
    width: number;
    height: number;
    sensorRadius: number;
    radioRange: number;
    spread: number;
    burnTicks: number;
    seed: number;
}

export const DEFAULT_WORLD: WorldConfig = {
    width: 60,
    height: 40,
    sensorRadius: 5,
    radioRange: 8,
    spread: 0.02,
    burnTicks: 60,
    seed: 7,
};

export interface ServerAgent {
    id: AgentId;
    isPhone: boolean;
    index: number;
    pos: Vec;
    target: Vec | null;
    alive: boolean;
    connected: boolean;
    disconnectedAt: number;
    inbox: Msg[];
    claim: string | null;
    mode: string;
    knownPct: number;
    color?: string;
    windEstimate?: Vec;
    send: (m: ServerToAgent) => void;
}

const REMOVE_AFTER_DISCONNECT = 30; // ticks
const CHATTER_KEEP = 20;
const FULL_FRAME_EVERY = 10; // ticks

export class World {
    readonly cfg: WorldConfig;
    tick = 0;
    rng: Rng;
    wind: Vec = { x: 1, y: 0 };
    lossPct = 0;
    jamZones: { center: Vec; radius: number }[] = [];
    scenario: Scenario;
    private agents = new Map<AgentId, ServerAgent>();
    private viewers = new Set<(m: ServerToViewer) => void>();
    private nextIndex = 0;
    private chatter: { from: AgentId; line: string; tick: number }[] = [];
    private observed: Uint8Array; // 1 = some agent's sensor saw fire there
    private lastCells: CellState[] = [];
    private ctlSeq = 0;
    private inspectId: AgentId | null = null;
    private inspected: { id: AgentId; map: string } | undefined;
    private attempted = 0;
    private dropped = 0;
    /** Optional hook so the server can log chatter or pipe it elsewhere. */
    onChatter?: (from: AgentId, line: string) => void;

    constructor(cfg: Partial<WorldConfig> = {}) {
        this.cfg = { ...DEFAULT_WORLD, ...cfg };
        this.rng = mulberry32(this.cfg.seed);
        this.observed = new Uint8Array(this.cfg.width * this.cfg.height);
        this.scenario = this.makeScenario("fire");
        this.scenario.init(this);
    }

    get radioRange(): number {
        return this.cfg.radioRange;
    }

    private makeScenario(id: ScenarioId): Scenario {
        const { width, height, spread, burnTicks } = this.cfg;
        if (id === "lights") {
            return createLightsScenario(width, height);
        }
        return createFireScenario({ width, height, spread, burnTicks });
    }

    // ---------- membership ----------

    addAgent(id: AgentId, isPhone: boolean, send: (m: ServerToAgent) => void): ServerAgent {
        const existing = this.agents.get(id);
        if (existing) {
            // Reconnect keeps position, claim and alive state.
            existing.send = send;
            existing.connected = true;
            existing.isPhone = isPhone;
            return existing;
        }
        const index = this.nextIndex++;
        const agent: ServerAgent = {
            id,
            isPhone,
            index,
            pos: this.scenario.spawn({ isPhone, index }, this),
            target: null,
            alive: true,
            connected: true,
            disconnectedAt: 0,
            inbox: [],
            claim: null,
            mode: "normal",
            knownPct: 0,
            send,
        };
        this.agents.set(id, agent);
        return agent;
    }

    disconnectAgent(id: AgentId): void {
        const a = this.agents.get(id);
        if (!a) {
            return;
        }
        a.connected = false;
        a.disconnectedAt = this.tick;
    }

    addViewer(send: (m: ServerToViewer) => void): () => void {
        this.viewers.add(send);
        send({ t: "view", view: this.view(true) });
        return () => this.viewers.delete(send);
    }

    liveAgents(): ServerAgent[] {
        return [...this.agents.values()].filter((a) => a.alive && a.connected);
    }

    allAgents(): ServerAgent[] {
        return [...this.agents.values()];
    }

    observedFire(x: number, y: number): boolean {
        return this.observed[y * this.cfg.width + x] === 1;
    }

    // ---------- radio ----------

    jammed(p: Vec): boolean {
        return this.jamZones.some((z) => dist(z.center, p) <= z.radius);
    }

    private linked(a: ServerAgent, b: ServerAgent): boolean {
        if (a === b || !a.alive || !b.alive || !a.connected || !b.connected) {
            return false;
        }
        if (this.jammed(a.pos) || this.jammed(b.pos)) {
            return false;
        }
        return dist(a.pos, b.pos) <= this.cfg.radioRange;
    }

    neighbours(a: ServerAgent): ServerAgent[] {
        return this.liveAgents().filter((b) => this.linked(a, b));
    }

    // ---------- actions ----------

    applyAction(id: AgentId, action: Action): void {
        const a = this.agents.get(id);
        if (!a || !a.alive) {
            return;
        }
        if (action.moveTo && Number.isFinite(action.moveTo.x) && Number.isFinite(action.moveTo.y)) {
            a.target = { x: action.moveTo.x, y: action.moveTo.y };
        }
        if (action.claimed !== undefined) {
            a.claim = action.claimed;
        }
        if (action.status) {
            a.mode = action.status.mode;
            a.knownPct = action.status.knownPct;
            a.windEstimate = action.status.windEstimate;
        }
        if (action.display) {
            a.color = action.display.color;
        }
        if (action.localMap && this.inspectId === id) {
            this.inspected = { id, map: action.localMap };
        }
        for (const m of (action.send ?? []).slice(0, 64)) {
            this.route(a, m);
        }
    }

    private route(from: ServerAgent, m: Omit<Msg, "from">): void {
        if (m.kind === "chatter") {
            // Recorded at send time, even when jammed: the audience hears it under static.
            const line = (m.body as { line?: unknown } | null)?.line;
            if (typeof line === "string") {
                this.chatter.push({ from: from.id, line, tick: this.tick });
                this.chatter = this.chatter.slice(-CHATTER_KEEP);
                this.onChatter?.(from.id, line);
            }
        }
        const msg: Msg = { ...m, from: from.id };
        for (const b of this.neighbours(from)) {
            this.attempted++;
            if (this.rng() * 100 < this.lossPct) {
                this.dropped++;
                continue;
            }
            b.inbox.push(msg);
        }
    }

    // ---------- controls ----------

    control(c: Control): void {
        switch (c.type) {
            case "addJam":
                this.jamZones.push({ center: c.center, radius: Math.max(0.5, Math.min(c.radius, 30)) });
                break;
            case "clearJams":
                this.jamZones = [];
                break;
            case "setWind":
                this.wind = { x: Math.max(-3, Math.min(3, c.wind.x)), y: Math.max(-3, Math.min(3, c.wind.y)) };
                break;
            case "setLoss":
                this.lossPct = Math.max(0, Math.min(100, c.pct));
                break;
            case "killAgent": {
                const a = this.agents.get(c.id);
                if (a) {
                    a.alive = false;
                    a.claim = null;
                }
                break;
            }
            case "goal":
                this.injectGoal(c.body);
                break;
            case "inspect":
                this.inspectId = c.id;
                this.inspected = undefined;
                break;
            case "switchScenario":
                this.switchScenario(c.scenario);
                break;
            case "reset":
                this.reset();
                break;
        }
    }

    /** Injected into ONE random live agent; it must spread by gossip. Returns who got it. */
    injectGoal(body: GoalBody): AgentId | null {
        // Prefer a drone that can actually hear the radio; a jammed one would silently drop it.
        const live = this.liveAgents();
        const reachable = live.filter((x) => !this.jammed(x.pos));
        const pool = reachable.length ? reachable : live;
        const a = pool[Math.floor(this.rng() * pool.length)];
        if (!a) {
            return null;
        }
        a.inbox.push({ id: `control~${this.ctlSeq++}`, from: "control", kind: "goal", ttl: 0, ts: this.tick, body });
        return a.id;
    }

    switchScenario(id: ScenarioId): void {
        this.scenario = this.makeScenario(id);
        this.resetState();
    }

    reset(): void {
        this.scenario = this.makeScenario(this.scenario.id);
        this.jamZones = [];
        this.lossPct = 0;
        this.wind = { x: 1, y: 0 };
        this.resetState();
    }

    private resetState(): void {
        this.tick = 0; // agents' runtimes re-init their brains when tick goes backwards
        this.scenario.init(this);
        this.observed.fill(0);
        this.chatter = [];
        this.inspected = undefined;
        this.lastCells = [];
        for (const a of this.agents.values()) {
            a.alive = true;
            a.claim = null;
            a.target = null;
            a.inbox = [];
            a.color = undefined;
            a.pos = this.scenario.spawn({ isPhone: a.isPhone, index: a.index }, this);
        }
    }

    // ---------- tick ----------

    step(): void {
        this.tick++;
        this.scenario.step(this);
        for (const a of [...this.agents.values()]) {
            if (!a.connected && this.tick - a.disconnectedAt > REMOVE_AFTER_DISCONNECT) {
                this.agents.delete(a.id);
            }
        }
        for (const a of this.agents.values()) {
            this.move(a);
        }
        for (const a of this.agents.values()) {
            if (!a.connected) {
                continue;
            }
            const sense = this.senseFor(a);
            a.inbox = [];
            try {
                a.send({ t: "sense", sense });
            } catch {
                this.disconnectAgent(a.id);
            }
        }
        this.broadcastView();
    }

    private move(a: ServerAgent): void {
        if (!a.alive || !a.target) {
            return;
        }
        const dx = a.target.x - a.pos.x;
        const dy = a.target.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        const k = d > 1 ? 1 / d : 1;
        a.pos = {
            x: Math.max(0, Math.min(this.cfg.width - 1, a.pos.x + dx * k)),
            y: Math.max(0, Math.min(this.cfg.height - 1, a.pos.y + dy * k)),
        };
    }

    private senseFor(a: ServerAgent): Sense {
        const jammed = this.jammed(a.pos);
        const base: Sense = {
            tick: this.tick,
            scenario: this.scenario.id,
            self: { id: a.id, pos: { ...a.pos }, alive: a.alive, jammed, isPhone: a.isPhone },
            nearbyCells: [],
            neighbours: [],
            inbox: [],
            tasks: [],
            clockMs: Date.now(),
        };
        if (!a.alive) {
            return base;
        }
        const r = this.cfg.sensorRadius;
        const cx = Math.round(a.pos.x);
        const cy = Math.round(a.pos.y);
        for (let y = cy - r; y <= cy + r; y++) {
            for (let x = cx - r; x <= cx + r; x++) {
                const s = this.scenario.cell(x, y);
                if (s === "unknown" || Math.hypot(x - cx, y - cy) > r) {
                    continue;
                }
                this.observed[y * this.cfg.width + x] = s === "fire" ? 1 : 0;
                base.nearbyCells.push({ x, y, state: s, ts: this.tick, by: a.id });
            }
        }
        base.neighbours = jammed ? [] : this.neighbours(a).map((b) => b.id);
        base.inbox = jammed ? [] : a.inbox;
        base.tasks = this.scenario.tasksFor(a, this);
        if (this.inspectId === a.id) {
            base.inspect = true;
        }
        return base;
    }

    // ---------- viewer ----------

    view(full: boolean): WorldView {
        const cells = this.scenario.cells();
        const live = this.allAgents().filter((a) => a.connected);
        const links: [AgentId, AgentId][] = [];
        for (let i = 0; i < live.length; i++) {
            for (let j = i + 1; j < live.length; j++) {
                if (this.linked(live[i]!, live[j]!)) {
                    links.push([live[i]!.id, live[j]!.id]);
                }
            }
        }
        const view: WorldView = {
            tick: this.tick,
            scenario: this.scenario.id,
            width: this.cfg.width,
            height: this.cfg.height,
            cells: full ? cells : [],
            agents: live.map((a) => ({
                id: a.id,
                pos: a.pos,
                alive: a.alive,
                jammed: this.jammed(a.pos),
                isPhone: a.isPhone,
                claim: a.claim,
                mode: a.alive ? a.mode : "dead",
                knownPct: a.knownPct,
                color: a.color,
                windEstimate: a.windEstimate,
            })),
            links,
            jamZones: this.jamZones,
            wind: this.wind,
            metrics: {
                edgeMappedPct: this.scenario.metrics(this).edgeMappedPct,
                msgLossPct: this.attempted ? (100 * this.dropped) / this.attempted : 0,
                aliveAgents: live.filter((a) => a.alive).length,
            },
            recentChatter: this.chatter,
            inspected: this.inspected,
        };
        if (!full) {
            const diff: [number, CellState][] = [];
            for (let i = 0; i < cells.length; i++) {
                if (cells[i] !== this.lastCells[i]) {
                    diff.push([i, cells[i]!]);
                }
            }
            view.cellDiff = diff;
        }
        this.lastCells = cells.slice();
        return view;
    }

    private broadcastView(): void {
        if (this.viewers.size === 0) {
            this.lastCells = [];
            return;
        }
        const full = this.tick % FULL_FRAME_EVERY === 0 || this.lastCells.length === 0;
        const msg: ServerToViewer = { t: "view", view: this.view(full) };
        // Decay loss stats so the gauge tracks recent conditions.
        this.attempted *= 0.95;
        this.dropped *= 0.95;
        for (const send of this.viewers) {
            try {
                send(msg);
            } catch {
                this.viewers.delete(send);
            }
        }
    }

    /** Facts for the LLM layer and its keyword fallback. */
    brief(): WorldBrief {
        const { width, height } = this.cfg;
        const cells = this.scenario.cells();
        let fire = 0;
        let burnt = 0;
        let sx = 0;
        let sy = 0;
        let vx = 0;
        let vy = 0;
        let vn = 0;
        cells.forEach((s, i) => {
            const x = i % width;
            const y = Math.floor(i / width);
            if (s === "fire") {
                fire++;
                sx += x;
                sy += y;
            } else if (s === "burnt") {
                burnt++;
            } else if (s === "village") {
                vx += x;
                vy += y;
                vn++;
            }
        });
        const village = vn ? { x: Math.round(vx / vn), y: Math.round(vy / vn) } : null;
        const fireCentre = fire ? { x: Math.round(sx / fire), y: Math.round(sy / fire) } : null;
        const live = this.liveAgents();
        const isolated = live.filter((a) => a.mode === "isolated").length;
        const text = [
            `Grid ${width}x${height}; x grows east, y grows south. Scenario: ${this.scenario.id}.`,
            `Village centre: ${village ? `(${village.x},${village.y})` : "destroyed"}. Burning cells: ${fire}, burnt: ${burnt}, fire centre: ${fireCentre ? `(${fireCentre.x},${fireCentre.y})` : "none"}.`,
            `Wind vector: (${this.wind.x.toFixed(1)},${this.wind.y.toFixed(1)}) (fire spreads toward it). Edge mapped: ${this.scenario.metrics(this).edgeMappedPct.toFixed(0)}%.`,
            `Drones alive: ${live.length}, isolated: ${isolated}, jam zones: ${this.jamZones.length}, packet loss: ${this.lossPct}%.`,
        ].join(" ");
        return { width, height, village, fireCentre, text, burning: fire, alive: live.length, isolated, wind: this.wind };
    }
}
