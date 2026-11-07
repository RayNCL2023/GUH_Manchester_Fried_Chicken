// HiveBrain: leaderless swarm agent. Pure: no DOM, no network, deterministic per (id, seed).
import type {
    Action,
    AgentBrain,
    AgentId,
    AgentMode,
    ClaimBody,
    GoalBody,
    HeartbeatBody,
    MapBody,
    Msg,
    ScenarioId,
    Sense,
    Task,
    Vec,
} from "../shared/types";
import { ChatterPlanner } from "./chatter";
import { LocalMap } from "./map";
import { claimBeats, dist, hashString, LruSet, makeMsgId, mulberry32, originOf, type Rng } from "./util";

export interface PolicyWeights {
    /** Distance term in the claim score numerator. */
    dist: number;
    /** Exponent on task value (higher = chase valuable tasks harder). */
    value: number;
    /** Penalty per other live claim within CROWD_RADIUS of the task (spreads agents out). */
    crowd: number;
    /** Exponent on the goal boost. */
    goal: number;
}

export const DEFAULT_WEIGHTS: PolicyWeights = { dist: 1, value: 1, crowd: 0.6, goal: 1 };

export interface HiveOptions {
    width?: number;
    height?: number;
    seed?: number;
    weights?: PolicyWeights;
    /** Radio range in cells (used only to detect when we're bridging). */
    radioRange?: number;
}

type OutMsg = Omit<Msg, "from">;

interface ClaimRec {
    claimant: AgentId;
    score: number;
    heard: number;
}

interface MyClaim {
    task: Task;
    score: number;
    arrivedAt: number | null;
}

interface GoalRec {
    body: GoalBody;
    receivedAt: number;
}

// Timings (ticks at 10 Hz)
const HEARTBEAT_EVERY = 3;
const CLAIM_REFRESH_EVERY = 10;
const GOSSIP_EVERY = 5;
const ANTI_ENTROPY_EVERY = 50;
const GOAL_REBROADCAST_EVERY = 40;
const GOAL_LIFETIME = 900;
const SILENCE_RELEASE = 20;
const CLAIM_STALE = 40;
const ISOLATED_AFTER = 10;
const EDGE_DWELL = 12;
const TASK_COOLDOWN = 30;
const TASK_FORGET = 100;
const CROWD_RADIUS = 4;
const RELAY_TTL = 2;
const GOSSIP_CAP = 200;

export class HiveBrain implements AgentBrain {
    id: AgentId = "";
    scenario: ScenarioId = "fire";
    readonly map: LocalMap;
    private rng: Rng = Math.random;
    private readonly seed: number;
    private readonly weights: PolicyWeights;
    private readonly radioRange: number;

    private tick = 0;
    private pos: Vec = { x: 0, y: 0 };
    private seq = 0;
    private outbox: OutMsg[] = [];

    private seen = new LruSet(2000);
    private claims = new Map<string, ClaimRec>();
    private myClaim: MyClaim | null = null;
    private cooldown = new Map<string, number>();
    private lastHeard = new Map<AgentId, number>();
    private peerPos = new Map<AgentId, Vec>();
    private neighbourSince = new Map<AgentId, number>();
    private lostAnnounced = new Map<AgentId, number>();
    private lastNeighbourTick = 0;
    private mode: AgentMode = "normal";
    private relayLog: number[] = [];
    private originLog: number[] = [];
    private goals = new Map<string, GoalRec>();
    private knownTasks = new Map<string, { task: Task; seen: number }>();
    private exploreTarget: Vec | null = null;
    private exploreSince = 0;
    private seenFire = false;
    private chatter = new ChatterPlanner();

    constructor(opts: HiveOptions = {}) {
        this.map = new LocalMap(opts.width ?? 60, opts.height ?? 40);
        this.seed = opts.seed ?? 0;
        this.weights = opts.weights ?? DEFAULT_WEIGHTS;
        this.radioRange = opts.radioRange ?? 8;
    }

    init(id: AgentId, scenario: ScenarioId): void {
        this.id = id;
        this.scenario = scenario;
        this.rng = mulberry32(hashString(id) ^ this.seed);
        this.chatter.minPriority = scenario === "lights" ? 3 : 1;
    }

    debug() {
        return { knownCells: this.map.known, claim: this.myClaim?.task.id ?? null, mode: this.mode };
    }

    /** Current goal-adjusted claim, exposed for tests and the sim. */
    get claim(): string | null {
        return this.myClaim?.task.id ?? null;
    }

    get currentMode(): AgentMode {
        return this.mode;
    }

    step(sense: Sense): Action {
        this.tick = sense.tick;
        this.pos = sense.self.pos;
        this.outbox = [];
        if (!sense.self.alive) {
            return {};
        }

        this.senseCells(sense);
        this.updateNeighbours(sense);
        this.processInbox(sense.inbox);
        this.expireClaims();
        this.updateTasks(sense.tasks);
        this.maintainClaim();
        if (!this.myClaim) {
            this.pickClaim();
        }
        this.periodicGossip();
        this.updateMode();

        const line = this.chatter.step(this.tick, this.rng);
        if (line) {
            this.emit("chatter", { line }, 0);
        }

        return this.buildAction(sense);
    }

    // ---------- sensing ----------

    private senseCells(sense: Sense): void {
        for (const c of sense.nearbyCells) {
            const changed = this.map.observe(c.x, c.y, c.state, this.tick, this.id);
            if (changed && c.state === "fire" && !this.seenFire) {
                this.seenFire = true;
                this.chatter.propose("fire_spotted", this.tick);
            }
        }
    }

    private updateNeighbours(sense: Sense): void {
        const now = new Set(sense.neighbours);
        if (now.size > 0) {
            this.lastNeighbourTick = this.tick;
        }
        for (const n of now) {
            this.lastHeard.set(n, this.tick);
            if (!this.neighbourSince.has(n)) {
                this.neighbourSince.set(n, this.tick);
            }
        }
        for (const [n, since] of this.neighbourSince) {
            if (now.has(n)) {
                continue;
            }
            const heard = this.lastHeard.get(n) ?? 0;
            if (this.tick - heard < SILENCE_RELEASE) {
                continue;
            }
            this.neighbourSince.delete(n);
            if (heard - since < 15) {
                continue;
            }
            const last = this.lostAnnounced.get(n) ?? -1e9;
            if (this.tick - last < 200) {
                continue;
            }
            this.lostAnnounced.set(n, this.tick);
            const m = /^Echo-([1-8])$/.exec(n);
            this.chatter.propose(m ? `lost_echo_${m[1]}` : "lost_unit", this.tick);
        }
    }

    // ---------- inbox ----------

    private processInbox(inbox: Msg[]): void {
        for (const msg of inbox) {
            if (this.seen.has(msg.id)) {
                continue;
            }
            this.seen.add(msg.id);
            const origin = originOf(msg.id);
            if (origin === this.id) {
                continue;
            }
            switch (msg.kind) {
                case "map":
                    this.onMap(msg.body as MapBody);
                    break;
                case "claim":
                    this.onClaim(msg.body as ClaimBody);
                    break;
                case "release":
                    this.onRelease(msg.body as ClaimBody);
                    break;
                case "heartbeat":
                    this.onHeartbeat(origin, msg.body as HeartbeatBody);
                    break;
                case "goal":
                    this.onGoal(msg);
                    break;
                case "chatter":
                    this.chatter.heard(this.tick);
                    break;
            }
            if (msg.kind === "goal" || msg.ttl <= 0) {
                continue;
            }
            if (msg.kind === "map" || msg.kind === "chatter") {
                continue;
            }
            this.outbox.push({ id: msg.id, kind: msg.kind, ttl: msg.ttl - 1, ts: msg.ts, body: msg.body });
            this.relayLog.push(this.tick);
        }
    }

    private onMap(body: MapBody): void {
        if (!body || !Array.isArray(body.cells)) {
            return;
        }
        for (const c of body.cells) {
            this.map.merge(c);
        }
    }

    private onClaim(body: ClaimBody): void {
        if (!body || body.claimant === this.id) {
            return;
        }
        this.lastHeard.set(body.claimant, this.tick);
        const existing = this.claims.get(body.taskId);
        if (existing && existing.claimant !== body.claimant) {
            if (!claimBeats(body.score, body.claimant, existing.score, existing.claimant)) {
                return;
            }
        }
        this.claims.set(body.taskId, { claimant: body.claimant, score: body.score, heard: this.tick });

        const mine = this.myClaim;
        if (!mine || mine.task.id !== body.taskId) {
            return;
        }
        if (claimBeats(mine.score, this.id, body.score, body.claimant)) {
            // We win: re-assert so the other agent learns quickly.
            this.broadcastClaim();
            return;
        }
        this.cooldown.set(mine.task.id, this.tick + TASK_COOLDOWN);
        this.myClaim = null;
        this.chatter.propose("yield", this.tick);
    }

    private onRelease(body: ClaimBody): void {
        if (!body) {
            return;
        }
        const rec = this.claims.get(body.taskId);
        if (rec && rec.claimant === body.claimant) {
            this.claims.delete(body.taskId);
        }
    }

    private onHeartbeat(origin: AgentId, body: HeartbeatBody): void {
        this.lastHeard.set(origin, this.tick);
        if (!body) {
            return;
        }
        this.peerPos.set(origin, body.pos);
        for (const [taskId, rec] of this.claims) {
            if (rec.claimant !== origin) {
                continue;
            }
            if (taskId === body.claim) {
                rec.heard = this.tick;
                continue;
            }
            this.claims.delete(taskId);
        }
    }

    private onGoal(msg: Msg): void {
        const body = msg.body as GoalBody;
        if (!body || !body.id || this.goals.has(body.id)) {
            return;
        }
        this.goals.set(body.id, { body, receivedAt: this.tick });
        // Flood: forward once on first hearing.
        this.emit("goal", body, 0);
        // Self-limiting audible ripple: only "copy" if our neighbourhood is quiet.
        if (this.chatter.quietFor(this.tick, 8)) {
            this.chatter.propose("goal_copy", this.tick);
        }
        // Re-plan immediately toward the goal.
        if (this.myClaim) {
            this.releaseClaim(false);
        }
        this.exploreTarget = null;
    }

    private expireClaims(): void {
        for (const [taskId, rec] of this.claims) {
            const heard = Math.max(rec.heard, this.lastHeard.get(rec.claimant) ?? -1e9);
            if (this.tick - (this.lastHeard.get(rec.claimant) ?? -1e9) > SILENCE_RELEASE) {
                this.claims.delete(taskId);
                continue;
            }
            if (this.tick - heard > CLAIM_STALE) {
                this.claims.delete(taskId);
            }
        }
        for (const [id, rec] of this.goals) {
            if (this.tick - rec.receivedAt > GOAL_LIFETIME) {
                this.goals.delete(id);
            }
        }
    }

    // ---------- tasks ----------

    private updateTasks(senseTasks: Task[]): void {
        for (const t of senseTasks) {
            this.knownTasks.set(t.id, { task: t, seen: this.tick });
        }
        if (this.scenario === "lights") {
            const live = new Set(senseTasks.map((t) => t.id));
            for (const id of this.knownTasks.keys()) {
                if (!live.has(id)) {
                    this.knownTasks.delete(id);
                }
            }
            return;
        }
        if (this.tick % GOSSIP_EVERY === 0) {
            this.deriveEdgeTasks();
        }
        for (const [id, rec] of this.knownTasks) {
            if (this.tick - rec.seen > TASK_FORGET) {
                this.knownTasks.delete(id);
                continue;
            }
            if (rec.task.kind !== "edge") {
                continue;
            }
            // Drop only when our map positively says the edge is gone (unknown = trust the report).
            const s = this.map.get(rec.task.pos.x, rec.task.pos.y);
            if (s === "clear" || s === "burnt") {
                this.knownTasks.delete(id);
            }
        }
    }

    /** Fire cells next to clear/village cells in our own map become edge tasks (same id scheme as server). */
    private deriveEdgeTasks(): void {
        const { w, h, state } = this.map;
        const villages: Vec[] = [];
        for (let i = 0; i < state.length; i++) {
            if (state[i] === 4) {
                villages.push({ x: i % w, y: Math.floor(i / w) });
            }
        }
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (state[y * w + x] !== 2) {
                    continue;
                }
                if (!this.isEdge(x, y)) {
                    continue;
                }
                const id = `edge:${x}:${y}`;
                const prev = this.knownTasks.get(id);
                if (prev) {
                    prev.seen = this.tick;
                    continue;
                }
                const pos = { x, y };
                const nearVillage = villages.some((v) => dist(v, pos) < 10);
                this.knownTasks.set(id, { task: { id, pos, kind: "edge", value: nearVillage ? 2 : 1 }, seen: this.tick });
            }
        }
    }

    private isEdge(x: number, y: number): boolean {
        const n = [this.map.get(x + 1, y), this.map.get(x - 1, y), this.map.get(x, y + 1), this.map.get(x, y - 1)];
        return n.some((s) => s === "clear" || s === "village");
    }

    private goalBoost(pos: Vec): number {
        let boost = 1;
        for (const { body } of this.goals.values()) {
            if (!body.target) {
                continue;
            }
            if (dist(body.target, pos) <= (body.radius ?? 8)) {
                boost = Math.max(boost, body.priority);
            }
        }
        return boost;
    }

    private score(task: Task): number {
        const w = this.weights;
        const d = dist(this.pos, task.pos);
        let crowd = 0;
        for (const [taskId, rec] of this.claims) {
            if (rec.claimant === this.id) {
                continue;
            }
            const t = this.knownTasks.get(taskId)?.task;
            if (t && dist(t.pos, task.pos) < CROWD_RADIUS) {
                crowd++;
            }
        }
        let value = Math.max(task.value, 0.01);
        if (task.kind === "edge") {
            // Patrol: edges we haven't looked at recently are worth more (stale info = likely missed spread).
            const ts = this.map.ts[task.pos.y * this.map.w + task.pos.x] ?? this.tick;
            value *= 1 + Math.min((this.tick - ts) / 40, 1.5);
        }
        const boost = this.goalBoost(task.pos);
        return ((1 + w.dist * d) / Math.pow(value, w.value)) * (1 + w.crowd * crowd) / Math.pow(boost, w.goal);
    }

    private pickClaim(): void {
        let best: Task | null = null;
        let bestScore = Infinity;
        for (const { task } of this.knownTasks.values()) {
            if ((this.cooldown.get(task.id) ?? -1) > this.tick) {
                continue;
            }
            const rec = this.claims.get(task.id);
            const s = this.score(task);
            // Only contest someone else's claim if we're clearly better (hysteresis avoids ping-pong).
            if (rec && rec.claimant !== this.id && !claimBeats(s * 1.25, this.id, rec.score, rec.claimant)) {
                continue;
            }
            if (s < bestScore) {
                bestScore = s;
                best = task;
            }
        }
        if (!best) {
            return;
        }
        this.myClaim = { task: best, score: bestScore, arrivedAt: null };
        this.broadcastClaim();
        this.chatter.propose(this.claimLineKey(best), this.tick);
    }

    private maintainClaim(): void {
        const mine = this.myClaim;
        if (!mine) {
            return;
        }
        const known = this.knownTasks.get(mine.task.id);
        if (!known) {
            this.releaseClaim(false);
            return;
        }
        mine.task = known.task;
        if (dist(this.pos, mine.task.pos) > 1.5) {
            return;
        }
        if (mine.arrivedAt === null) {
            mine.arrivedAt = this.tick;
            if (mine.task.kind === "slot") {
                this.chatter.propose("slot_locked", this.tick);
            }
        }
        if (mine.task.kind === "edge" && this.tick - mine.arrivedAt >= EDGE_DWELL) {
            this.releaseClaim(true);
        }
    }

    private releaseClaim(withCooldown: boolean): void {
        const mine = this.myClaim;
        if (!mine) {
            return;
        }
        if (withCooldown) {
            this.cooldown.set(mine.task.id, this.tick + TASK_COOLDOWN);
        }
        this.emit("release", { taskId: mine.task.id, claimant: this.id, ts: this.tick, score: mine.score }, RELAY_TTL);
        this.myClaim = null;
    }

    private broadcastClaim(): void {
        const mine = this.myClaim;
        if (!mine) {
            return;
        }
        this.emit("claim", { taskId: mine.task.id, claimant: this.id, ts: this.tick, score: mine.score }, RELAY_TTL);
    }

    private claimLineKey(task: Task): string {
        if (task.kind === "protect") {
            return "protect";
        }
        if (task.kind === "slot") {
            return "slot_locked";
        }
        const c = this.fireCentroid() ?? { x: this.map.w / 2, y: this.map.h / 2 };
        const dx = task.pos.x - c.x;
        const dy = task.pos.y - c.y;
        if (Math.abs(dx) > Math.abs(dy)) {
            return dx > 0 ? "claim_east" : "claim_west";
        }
        return dy > 0 ? "claim_south" : "claim_north";
    }

    private fireCentroid(): Vec | null {
        let sx = 0;
        let sy = 0;
        let n = 0;
        const { w, state } = this.map;
        for (let i = 0; i < state.length; i++) {
            if (state[i] !== 2 && state[i] !== 3) {
                continue;
            }
            sx += i % w;
            sy += Math.floor(i / w);
            n++;
        }
        return n ? { x: sx / n, y: sy / n } : null;
    }

    // ---------- gossip ----------

    private emit(kind: Msg["kind"], body: unknown, ttl: number): void {
        this.outbox.push({ id: makeMsgId(this.id, this.seq++), kind, ttl, ts: this.tick, body });
        this.originLog.push(this.tick);
    }

    private periodicGossip(): void {
        const t = this.tick + (hashString(this.id) % 3); // stagger agents
        if (t % HEARTBEAT_EVERY === 0) {
            const hb: HeartbeatBody = { pos: this.pos, claim: this.claim };
            this.emit("heartbeat", hb, RELAY_TTL);
        }
        if (this.myClaim && t % CLAIM_REFRESH_EVERY === 0) {
            this.broadcastClaim();
        }
        if (this.scenario === "lights") {
            return;
        }
        if (t % GOSSIP_EVERY === 0 && this.map.dirty.size > 0) {
            this.emit("map", { cells: this.map.takeDirty(GOSSIP_CAP) } satisfies MapBody, 0);
        }
        if (t % ANTI_ENTROPY_EVERY === 0) {
            this.emit("map", { cells: this.map.sample(120, this.rng) } satisfies MapBody, 0);
        }
        if (t % GOAL_REBROADCAST_EVERY === 0) {
            for (const { body } of this.goals.values()) {
                this.emit("goal", body, 0);
            }
        }
    }

    private updateMode(): void {
        const window = this.tick - 30;
        this.relayLog = this.relayLog.filter((t) => t > window);
        this.originLog = this.originLog.filter((t) => t > window);
        const prev = this.mode;
        let next: AgentMode = "normal";
        if (this.tick - this.lastNeighbourTick >= ISOLATED_AFTER) {
            next = "isolated";
        } else if (this.isBridge()) {
            next = "relay";
        }
        this.mode = next;
        if (prev === next) {
            return;
        }
        if (next === "isolated") {
            this.chatter.propose("isolated", this.tick);
            return;
        }
        if (prev === "isolated") {
            this.chatter.propose("reconnected", this.tick);
            return;
        }
        if (next === "relay") {
            this.chatter.propose("relay_up", this.tick);
        }
    }

    /** Relay = we bridge two current neighbours that are out of range of each other (from heartbeat positions). */
    private isBridge(): boolean {
        if (this.relayLog.length === 0) {
            return false;
        }
        const pts: Vec[] = [];
        for (const n of this.neighbourSince.keys()) {
            if (this.tick - (this.lastHeard.get(n) ?? -1e9) > 3) {
                continue;
            }
            const p = this.peerPos.get(n);
            if (p) {
                pts.push(p);
            }
        }
        for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) {
                if (dist(pts[i]!, pts[j]!) > this.radioRange) {
                    return true;
                }
            }
        }
        return false;
    }

    // ---------- movement + action ----------

    private moveTarget(): Vec {
        if (this.myClaim) {
            return this.myClaim.task.pos;
        }
        const goal = this.activeGoalTarget();
        if (goal && dist(goal, this.pos) > 3) {
            return goal;
        }
        const stale = this.tick - this.exploreSince > 60;
        const reached = this.exploreTarget && dist(this.exploreTarget, this.pos) < 1.5;
        if (!this.exploreTarget || reached || stale) {
            this.exploreTarget = this.chooseExploreTarget();
            this.exploreSince = this.tick;
        }
        return this.exploreTarget;
    }

    private activeGoalTarget(): Vec | null {
        let best: GoalRec | null = null;
        for (const rec of this.goals.values()) {
            if (!rec.body.target) {
                continue;
            }
            if (!best || rec.body.priority > best.body.priority) {
                best = rec;
            }
        }
        return best?.body.target ?? null;
    }

    /** Sample cells; prefer nearby unknown cells away from peers, else the stalest known cell. */
    private chooseExploreTarget(): Vec {
        const { w, h } = this.map;
        let best: Vec | null = null;
        let bestCost = Infinity;
        let stalest: Vec | null = null;
        let stalestTs = Infinity;
        for (let k = 0; k < 40; k++) {
            const x = Math.floor(this.rng() * w);
            const y = Math.floor(this.rng() * h);
            const i = y * w + x;
            const p = { x, y };
            if (this.map.state[i] !== 0) {
                if (this.map.ts[i]! < stalestTs) {
                    stalestTs = this.map.ts[i]!;
                    stalest = p;
                }
                continue;
            }
            let cost = dist(p, this.pos);
            for (const [peer, pp] of this.peerPos) {
                if (this.tick - (this.lastHeard.get(peer) ?? -1e9) > SILENCE_RELEASE) {
                    continue;
                }
                if (dist(pp, p) < 6) {
                    cost += 10;
                }
            }
            if (cost < bestCost) {
                bestCost = cost;
                best = p;
            }
        }
        return best ?? stalest ?? { x: Math.floor(this.rng() * w), y: Math.floor(this.rng() * h) };
    }

    private buildAction(sense: Sense): Action {
        const action: Action = {
            moveTo: this.moveTarget(),
            send: this.outbox,
            claimed: this.claim,
            status: { mode: this.mode, knownPct: this.map.knownPct() },
        };
        if (this.scenario === "lights") {
            const onSlot = this.myClaim && dist(this.pos, this.myClaim.task.pos) <= 1.5;
            action.display = { color: onSlot ? (this.myClaim!.task.color ?? "#ffffff") : "#000000" };
        }
        if (sense.inspect) {
            action.localMap = this.map.encode();
        }
        return action;
    }
}
