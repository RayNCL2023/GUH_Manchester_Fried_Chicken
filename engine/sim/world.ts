// Headless in-process world for testing/tuning/training brains. Mirrors the server's rules:
// sensor radius 3, radio range 8, jam zones block, global loss %, 1 cell/tick movement, msgs arrive next tick.
import type { Action, AgentBrain, AgentId, CellObs, CellState, GoalBody, Msg, Sense, Task, Vec } from "../../shared/types";
import { dist, mulberry32, type Rng } from "../util";

export interface SimConfig {
    width: number;
    height: number;
    agents: number;
    lossPct: number;
    radioRange: number;
    sensorRadius: number;
    seed: number;
    wind: Vec;
    jamZones: { center: Vec; radius: number }[];
    /** Fire spread probability per burning neighbour per tick (before wind). */
    spread: number;
    burnTicks: number;
    makeBrain: (id: AgentId) => AgentBrain;
}

interface SimAgent {
    id: AgentId;
    pos: Vec;
    alive: boolean;
    brain: AgentBrain;
    inbox: Msg[];
    claim: string | null;
}

export interface SimMetrics {
    tick: number;
    edgeCells: number;
    edgeMappedPct: number;
    duplicateClaims: number;
    maxDuplicateRun: number;
    avgKnownPct: number;
    aliveAgents: number;
    messagesSent: number;
    messagesDelivered: number;
}

export const DEFAULT_SIM: Omit<SimConfig, "makeBrain"> = {
    width: 60,
    height: 40,
    agents: 8,
    lossPct: 50,
    radioRange: 8,
    sensorRadius: 3,
    seed: 1,
    wind: { x: 1, y: 0 },
    jamZones: [],
    spread: 0.02,
    burnTicks: 60,
};

export class SimWorld {
    readonly cfg: SimConfig;
    cells: CellState[];
    burnAge: Int32Array;
    agents: SimAgent[] = [];
    tick = 0;
    private rng: Rng;
    private dupRuns = new Map<string, number>();
    maxDuplicateRun = 0;
    messagesSent = 0;
    messagesDelivered = 0;
    private ctlSeq = 0;
    /** Hook: called for every message an agent sends (used to record chatter). */
    onSend?: (from: AgentId, m: Omit<Msg, "from">) => void;

    constructor(cfg: Partial<SimConfig> & Pick<SimConfig, "makeBrain">) {
        this.cfg = { ...DEFAULT_SIM, ...cfg };
        const { width, height } = this.cfg;
        this.rng = mulberry32(this.cfg.seed);
        this.cells = new Array<CellState>(width * height).fill("clear");
        this.burnAge = new Int32Array(width * height);
        for (let y = 27; y < 30; y++) {
            for (let x = 16; x < 19; x++) {
                this.cells[y * width + x] = "village";
            }
        }
        for (let y = 12; y < 14; y++) {
            for (let x = 30; x < 32; x++) {
                this.cells[y * width + x] = "fire";
            }
        }
        for (let n = 0; n < this.cfg.agents; n++) {
            const id = `Echo-${n + 1}`;
            const brain = this.cfg.makeBrain(id);
            brain.init(id, "fire");
            this.agents.push({ id, pos: { x: 2 + (n % 4), y: 36 + Math.floor(n / 4) }, alive: true, brain, inbox: [], claim: null });
        }
    }

    cell(x: number, y: number): CellState {
        if (x < 0 || y < 0 || x >= this.cfg.width || y >= this.cfg.height) {
            return "unknown";
        }
        return this.cells[y * this.cfg.width + x]!;
    }

    isEdge(x: number, y: number): boolean {
        if (this.cell(x, y) !== "fire") {
            return false;
        }
        const n = [this.cell(x + 1, y), this.cell(x - 1, y), this.cell(x, y + 1), this.cell(x, y - 1)];
        return n.some((s) => s === "clear" || s === "village");
    }

    jammed(p: Vec): boolean {
        return this.cfg.jamZones.some((z) => dist(z.center, p) <= z.radius);
    }

    kill(id: AgentId): void {
        const a = this.agents.find((x) => x.id === id);
        if (a) {
            a.alive = false;
        }
    }

    injectGoal(body: GoalBody): void {
        const alive = this.agents.filter((a) => a.alive);
        const a = alive[Math.floor(this.rng() * alive.length)];
        if (!a) {
            return;
        }
        a.inbox.push({ id: `control~${this.ctlSeq++}`, from: "control", kind: "goal", ttl: 0, ts: this.tick, body });
    }

    private stepFire(): void {
        const { width, height, wind, spread, burnTicks } = this.cfg;
        const next = this.cells.slice();
        const wl = Math.hypot(wind.x, wind.y);
        const dirs = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ] as const;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (this.cells[i] !== "fire") {
                    continue;
                }
                this.burnAge[i]!++;
                if (this.burnAge[i]! >= burnTicks) {
                    next[i] = "burnt";
                }
                for (const [dx, dy] of dirs) {
                    const nx = x + dx;
                    const ny = y + dy;
                    const s = this.cell(nx, ny);
                    if (s !== "clear" && s !== "village") {
                        continue;
                    }
                    const along = wl ? (dx * wind.x + dy * wind.y) / wl : 0;
                    const p = spread * Math.max(0.15, 1 + along * Math.min(wl, 2));
                    if (this.rng() < p) {
                        next[ny * width + nx] = "fire";
                    }
                }
            }
        }
        this.cells = next;
    }

    private nearbyCells(p: Vec): CellObs[] {
        const r = this.cfg.sensorRadius;
        const out: CellObs[] = [];
        const cx = Math.round(p.x);
        const cy = Math.round(p.y);
        for (let y = cy - r; y <= cy + r; y++) {
            for (let x = cx - r; x <= cx + r; x++) {
                const s = this.cell(x, y);
                if (s === "unknown" || Math.hypot(x - cx, y - cy) > r) {
                    continue;
                }
                out.push({ x, y, state: s, ts: this.tick, by: "sensor" });
            }
        }
        return out;
    }

    private tasksFor(p: Vec): Task[] {
        const out: Task[] = [];
        const r = this.cfg.radioRange;
        const { width } = this.cfg;
        for (let y = Math.max(0, Math.floor(p.y - r)); y <= Math.min(this.cfg.height - 1, p.y + r); y++) {
            for (let x = Math.max(0, Math.floor(p.x - r)); x <= Math.min(width - 1, p.x + r); x++) {
                if (Math.hypot(x - p.x, y - p.y) > r) {
                    continue;
                }
                if (this.isEdge(x, y)) {
                    out.push({ id: `edge:${x}:${y}`, pos: { x, y }, kind: "edge", value: 1 });
                }
            }
        }
        return out;
    }

    private linked(a: SimAgent, b: SimAgent): boolean {
        if (!a.alive || !b.alive || a === b) {
            return false;
        }
        if (this.jammed(a.pos) || this.jammed(b.pos)) {
            return false;
        }
        return dist(a.pos, b.pos) <= this.cfg.radioRange;
    }

    step(): void {
        this.tick++;
        this.stepFire();
        const actions = new Map<AgentId, Action>();
        for (const a of this.agents) {
            if (!a.alive) {
                continue;
            }
            const neighbours = this.agents.filter((b) => this.linked(a, b)).map((b) => b.id);
            const sense: Sense = {
                tick: this.tick,
                scenario: "fire",
                self: { id: a.id, pos: { ...a.pos }, alive: true, jammed: this.jammed(a.pos), isPhone: false },
                nearbyCells: this.nearbyCells(a.pos),
                neighbours,
                inbox: a.inbox,
                tasks: this.tasksFor(a.pos),
                clockMs: this.tick * 100,
            };
            a.inbox = [];
            actions.set(a.id, a.brain.step(sense));
        }
        for (const a of this.agents) {
            const act = actions.get(a.id);
            if (!act) {
                continue;
            }
            a.claim = act.claimed ?? null;
            this.route(a, act);
            this.move(a, act.moveTo);
        }
        this.trackDuplicates();
    }

    private route(a: SimAgent, act: Action): void {
        for (const m of act.send ?? []) {
            this.messagesSent++;
            this.onSend?.(a.id, m);
            for (const b of this.agents) {
                if (!this.linked(a, b)) {
                    continue;
                }
                if (this.rng() * 100 < this.cfg.lossPct) {
                    continue;
                }
                b.inbox.push({ ...m, from: a.id });
                this.messagesDelivered++;
            }
        }
    }

    private move(a: SimAgent, to?: Vec): void {
        if (!to) {
            return;
        }
        const dx = to.x - a.pos.x;
        const dy = to.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        const k = d > 1 ? 1 / d : 1;
        a.pos.x = Math.max(0, Math.min(this.cfg.width - 1, a.pos.x + dx * k));
        a.pos.y = Math.max(0, Math.min(this.cfg.height - 1, a.pos.y + dy * k));
    }

    private trackDuplicates(): void {
        const holders = new Map<string, number>();
        for (const a of this.agents) {
            if (a.alive && a.claim) {
                holders.set(a.claim, (holders.get(a.claim) ?? 0) + 1);
            }
        }
        for (const [task, n] of holders) {
            if (n < 2) {
                continue;
            }
            const run = (this.dupRuns.get(task) ?? 0) + 1;
            this.dupRuns.set(task, run);
            this.maxDuplicateRun = Math.max(this.maxDuplicateRun, run);
        }
        for (const task of this.dupRuns.keys()) {
            if ((holders.get(task) ?? 0) < 2) {
                this.dupRuns.delete(task);
            }
        }
    }

    metrics(): SimMetrics {
        const { width, height } = this.cfg;
        let edge = 0;
        let mapped = 0;
        const alive = this.agents.filter((a) => a.alive);
        const maps = alive.map((a) => (a.brain as { map?: { get(x: number, y: number): CellState } }).map);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!this.isEdge(x, y)) {
                    continue;
                }
                edge++;
                if (maps.some((m) => m?.get(x, y) === "fire")) {
                    mapped++;
                }
            }
        }
        const known = alive.map((a) => (a.brain as { map?: { knownPct(): number } }).map?.knownPct() ?? 0);
        let dupNow = 0;
        for (const run of this.dupRuns.values()) {
            if (run > 0) {
                dupNow++;
            }
        }
        return {
            tick: this.tick,
            edgeCells: edge,
            edgeMappedPct: edge ? (100 * mapped) / edge : 100,
            duplicateClaims: dupNow,
            maxDuplicateRun: this.maxDuplicateRun,
            avgKnownPct: known.length ? known.reduce((s, v) => s + v, 0) / known.length : 0,
            aliveAgents: alive.length,
            messagesSent: this.messagesSent,
            messagesDelivered: this.messagesDelivered,
        };
    }
}
