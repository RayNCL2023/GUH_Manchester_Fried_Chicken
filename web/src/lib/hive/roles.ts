// Specialist drones that fly with the Echo flock. Each wraps a HiveBrain so it is a full peer on the mesh
// (map gossip, heartbeats, goal flooding, relaying), but overrides where it flies and keeps its own claims
// off the air so it never steals an edge from an Echo.
//   Sky-n:   high-altitude scouts. Huge camera footprint; sweep the area, then hold over the fire, push its
//            outline to everyone and flood a "Fire spotted" goal that pulls the whole flock in.
//   Water-n: heavy-lift firefighters. Fly to the hottest edge (buildings first), spray from upwind until
//            the tank runs dry, refill at the nearest water, repeat.
import { HiveBrain, makeMsgId, originOf } from "@mfc/engine";
import type { Action, AgentBrain, AgentId, CellObs, GoalBody, HeartbeatBody, Msg, ScenarioId, Sense, Vec } from "../../../../shared/types";

export type Role = "echo" | "sky" | "water";

export type UnitInfo = {
	role: Role;
	sensor: number; // camera footprint half-side, cells
	aim?: Vec; // water: where the jet lands
	spraying?: boolean;
	tank?: number; // water: 0..1
	phase?: string;
};

export const FIRE_GOAL = "Fire spotted";

// Flight heights. Echo and Water: clearance over the tallest thing nearby; Sky: above the area's ground.
export const ALTITUDE_M: Record<Role, number> = { echo: 32, sky: 150, water: 16 };

const FIRE = 2;
const CLEAR = 1;
const VILLAGE = 4;
const N4 = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
] as const;

type OutMsg = Omit<Msg, "from">;

function dist(a: Vec, b: Vec) {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

abstract class RoleBrain implements AgentBrain {
	readonly hive: HiveBrain;
	protected id: AgentId = "";
	protected tick = 0;
	protected pos: Vec = { x: 0, y: 0 };
	protected out: OutMsg[] = [];
	private seq = 0;

	constructor(protected readonly w: number, protected readonly h: number, seed: number, radioRange: number) {
		this.hive = new HiveBrain({ width: w, height: h, seed, radioRange });
	}

	// SimWorld metrics read brain.map.
	get map() {
		return this.hive.map;
	}

	init(id: AgentId, scenario: ScenarioId) {
		this.id = id;
		this.hive.init(id, scenario);
	}

	debug() {
		return { ...this.hive.debug(), claim: null };
	}

	abstract info(): UnitInfo;
	protected abstract target(sense: Sense): Vec;

	step(sense: Sense): Action {
		this.tick = sense.tick;
		this.pos = sense.self.pos;
		this.out = [];
		const act = this.hive.step(sense);
		const mine = (m: OutMsg) => originOf(m.id) === this.id;
		const send = (act.send ?? [])
			.filter((m) => !((m.kind === "claim" || m.kind === "release") && mine(m)))
			.map((m) => (m.kind === "heartbeat" && mine(m) ? { ...m, body: { ...(m.body as HeartbeatBody), claim: null } } : m));
		const moveTo = this.target(sense);
		return { ...act, moveTo, send: [...send, ...this.out], claimed: null };
	}

	protected emit(kind: Msg["kind"], body: unknown) {
		this.out.push({ id: makeMsgId(this.id, 1_000_000 + this.seq++), kind, ttl: 0, ts: this.tick, body });
	}

	protected say(line: string) {
		this.emit("chatter", { line });
	}

	// Burning cells next to clear ground or buildings, by this drone's own (gossiped) map.
	protected edges() {
		const { w, h, state } = this.map;
		const out: { x: number; y: number; nearBuilding: boolean }[] = [];
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (state[y * w + x] !== FIRE) {
					continue;
				}
				let edge = false;
				let building = false;
				for (const [dx, dy] of N4) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
						continue;
					}
					const s = state[ny * w + nx];
					edge ||= s === CLEAR || s === VILLAGE;
					building ||= s === VILLAGE;
				}
				if (edge) {
					out.push({ x, y, nearBuilding: building });
				}
			}
		}
		return out;
	}

	protected fireExtent(): { c: Vec; r: number; n: number } | null {
		const { w, state } = this.map;
		let sx = 0;
		let sy = 0;
		let n = 0;
		for (let i = 0; i < state.length; i++) {
			if (state[i] === FIRE) {
				sx += i % w;
				sy += Math.floor(i / w);
				n++;
			}
		}
		if (!n) {
			return null;
		}
		const c = { x: sx / n, y: sy / n };
		let r = 0;
		for (let i = 0; i < state.length; i++) {
			if (state[i] === FIRE) {
				r = Math.max(r, Math.hypot((i % w) - c.x, Math.floor(i / w) - c.y));
			}
		}
		return { c, r, n };
	}

	protected clamp(p: Vec): Vec {
		return { x: Math.max(0, Math.min(this.w - 1, p.x)), y: Math.max(0, Math.min(this.h - 1, p.y)) };
	}
}

// ---------- Sky: high-altitude scout and dispatcher ----------

const FIRE_PUSH_EVERY = 10;
const FIRE_PUSH_CAP = 400;
const DISPATCH_EVERY = 20;
const GOAL_MOVE = 4; // cells a fire's centre must drift before we re-plot it
const GOAL_REFRESH = 300;
const STAND_DOWN_AFTER = 30; // ticks a fire must stay gone before its crew is released
const FIRE_GAP = 5; // burning cells closer than this belong to the same fire (bridges a burnt-out middle)
const MERGE_SMALL = 15; // spot fires this close to a bigger one join it rather than get their own crew
const SMALL_FIRE = 8; // cells
const MAX_FIRES = 6;
const SLOT_MATCH = 12; // a fire within this of last dispatch's is the same fire
const DEFER_TO_PEER = 30; // a lower-numbered scout is on the air: it dispatches, we just watch
const ECHO_FRESH = 60;

export type Fire = { c: Vec; r: number; cells: number; edge: number };
type Slot = { n: number; fire: Fire; crew: AgentId[]; sentAt: number; sentC: Vec; seenAt: number };

export class SkyBrain extends RoleBrain {
	private lanes: Vec[] = [];
	private wide: Vec[] = []; // whole-area sweep, for a spare scout once the others are watching fires
	private lane = 0;
	private fires: Fire[] = [];
	private slots: Slot[] = [];
	private nextSlot = 1;
	private crewOf = new Map<AgentId, number>(); // echo -> slot n
	private echoes = new Map<AgentId, { pos: Vec; tick: number }>();
	private peerDispatch = -1e9;
	private announced = false;

	constructor(
		w: number,
		h: number,
		seed: number,
		radioRange: number,
		private readonly index: number,
		private readonly count: number,
		readonly sensor: number,
	) {
		super(w, h, seed, radioRange);
		this.lanes = this.sweep(this.index, this.count);
		this.wide = this.sweep(0, 1);
	}

	info(): UnitInfo {
		const n = this.fires.length;
		const watching = this.index < n;
		return { role: "sky", sensor: this.sensor, phase: watching ? `watching fire ${this.index + 1} of ${n}` : n ? "searching for more fires" : "sweeping" };
	}

	// Lawnmower over strip `part` of `parts`, lanes one footprint apart.
	private sweep(part: number, parts: number): Vec[] {
		const x0 = (part * this.w) / parts;
		const x1 = ((part + 1) * this.w) / parts;
		const inset = Math.min(this.sensor * 0.8, (x1 - x0) / 2);
		const step = Math.max(2, this.sensor * 1.6);
		const pts: Vec[] = [];
		let flip = false;
		for (let y = Math.min(this.sensor * 0.8, this.h / 2); y <= this.h - 1; y += step) {
			const row = [
				{ x: x0 + inset, y },
				{ x: x1 - inset, y },
			];
			pts.push(...(flip ? row.reverse() : row));
			flip = !flip;
		}
		return pts.length ? pts : [{ x: (x0 + x1) / 2, y: this.h / 2 }];
	}

	protected target(sense: Sense): Vec {
		this.listen(sense.inbox);
		if (this.tick % 5 === 0) {
			this.fires = this.findFires();
		}
		if (this.fires.length && !this.announced) {
			this.announced = true;
			this.say(`${this.id}: fire spotted from altitude, directing the flock`);
		}
		if (this.fires.length && this.tick % FIRE_PUSH_EVERY === 0) {
			this.pushOutline();
		}
		if (this.tick % DISPATCH_EVERY === 0) {
			this.dispatch();
		}
		// One scout per fire, biggest first. Spare scouts keep searching: a second fire is only found if
		// somebody is still looking.
		const fire = this.fires[this.index];
		if (fire) {
			const a = this.tick * 0.003;
			const r = Math.min(fire.r * 0.5, this.sensor * 0.5);
			return this.clamp({ x: fire.c.x + Math.cos(a) * r, y: fire.c.y + Math.sin(a) * r });
		}
		const lanes = this.fires.length ? this.wide : this.lanes;
		const wp = lanes[this.lane % lanes.length];
		if (dist(wp, this.pos) < 2) {
			this.lane++;
		}
		return lanes[this.lane % lanes.length];
	}

	private listen(inbox: Msg[]) {
		for (const m of inbox) {
			const origin = originOf(m.id);
			if (origin === this.id) {
				continue;
			}
			if (m.kind === "heartbeat" && origin.startsWith("Echo-")) {
				this.echoes.set(origin, { pos: (m.body as HeartbeatBody).pos, tick: this.tick });
			}
			if (m.kind === "heartbeat" && origin.startsWith("Sky-") && origin < this.id) {
				this.peerDispatch = this.tick;
			}
		}
	}

	// Separate fires = clusters of burning cells, merged across gaps narrower than FIRE_GAP.
	private findFires(): Fire[] {
		const { w, h, state } = this.map;
		const seen = new Uint8Array(w * h);
		const fires: Fire[] = [];
		for (let i = 0; i < state.length; i++) {
			if (state[i] !== FIRE || seen[i]) {
				continue;
			}
			const stack = [i];
			seen[i] = 1;
			const cells: number[] = [];
			while (stack.length) {
				const k = stack.pop()!;
				cells.push(k);
				const kx = k % w;
				const ky = Math.floor(k / w);
				for (let dy = -FIRE_GAP; dy <= FIRE_GAP; dy++) {
					for (let dx = -FIRE_GAP; dx <= FIRE_GAP; dx++) {
						const nx = kx + dx;
						const ny = ky + dy;
						if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
							continue;
						}
						const j = ny * w + nx;
						if (state[j] === FIRE && !seen[j]) {
							seen[j] = 1;
							stack.push(j);
						}
					}
				}
			}
			let sx = 0;
			let sy = 0;
			let edge = 0;
			for (const k of cells) {
				sx += k % w;
				sy += Math.floor(k / w);
				const kx = k % w;
				const ky = Math.floor(k / w);
				if (N4.some(([dx, dy]) => this.map.inBounds(kx + dx, ky + dy) && (state[(ky + dy) * w + kx + dx] === CLEAR || state[(ky + dy) * w + kx + dx] === VILLAGE))) {
					edge++;
				}
			}
			const c = { x: sx / cells.length, y: sy / cells.length };
			let r = 0;
			for (const k of cells) {
				r = Math.max(r, Math.hypot((k % w) - c.x, Math.floor(k / w) - c.y));
			}
			fires.push({ c, r, cells: cells.length, edge });
		}
		fires.sort((a, b) => b.cells - a.cells);
		// Spot fires next to a main fire are part of it.
		const merged: Fire[] = [];
		for (const f of fires) {
			const host = f.cells < SMALL_FIRE ? merged.find((m) => dist(m.c, f.c) < MERGE_SMALL + m.r) : null;
			if (!host) {
				merged.push({ ...f });
				continue;
			}
			host.edge += f.edge;
			host.r = Math.max(host.r, dist(host.c, f.c) + f.r);
		}
		return merged.sort((a, b) => b.edge - a.edge).slice(0, MAX_FIRES);
	}

	// Match fires to last round's slots (so each keeps its name and crew), split the Echoes across them in
	// proportion to fire perimeter, and send each fire's goal with its crew list.
	private dispatch() {
		if (this.tick - this.peerDispatch < DEFER_TO_PEER) {
			this.slots = []; // the lower-numbered scout is dispatching; start clean if we ever take over
			this.crewOf.clear();
			return;
		}
		for (const fire of this.fires) {
			let best: Slot | null = null;
			for (const s of this.slots) {
				if (s.seenAt !== this.tick && dist(s.fire.c, fire.c) < SLOT_MATCH && (!best || dist(s.fire.c, fire.c) < dist(best.fire.c, fire.c))) {
					best = s;
				}
			}
			if (best) {
				best.fire = fire;
				best.seenAt = this.tick;
			} else {
				this.slots.push({ n: this.nextSlot++, fire, crew: [], sentAt: -1e9, sentC: fire.c, seenAt: this.tick });
			}
		}
		// Fires gone for a while: release their crews.
		for (const s of [...this.slots]) {
			if (this.tick - s.seenAt > STAND_DOWN_AFTER) {
				this.slots.splice(this.slots.indexOf(s), 1);
				this.emit("goal", { id: `${this.id}-clear${s.n}-${this.tick}`, text: `${FIRE_GOAL} #${s.n}`, priority: 0 } satisfies GoalBody);
				this.say(`${this.id}: fire ${s.n} is out, crew released`);
				for (const [e, n] of this.crewOf) {
					if (n === s.n) {
						this.crewOf.delete(e);
					}
				}
			}
		}
		if (!this.slots.length) {
			this.announced = false;
			return;
		}
		this.assign();
		for (const s of this.slots) {
			const moved = dist(s.sentC, s.fire.c) > GOAL_MOVE;
			const crew = [...this.crewOf].filter(([, n]) => n === s.n).map(([e]) => e).sort();
			const changed = crew.join() !== s.crew.join();
			if (!moved && !changed && this.tick - s.sentAt < GOAL_REFRESH) {
				continue;
			}
			s.crew = crew;
			s.sentAt = this.tick;
			s.sentC = s.fire.c;
			const body: GoalBody = {
				id: `${this.id}-fire${s.n}-${this.tick}`,
				text: `${FIRE_GOAL} #${s.n}`,
				target: { x: Math.round(s.fire.c.x), y: Math.round(s.fire.c.y) },
				radius: Math.max(8, Math.ceil(s.fire.r) + 4),
				priority: 2,
				// One fire: everyone goes. Several: each crew to its own.
				assignees: this.slots.length > 1 ? crew : undefined,
			};
			this.emit("goal", body);
		}
	}

	private assign() {
		const live = [...this.echoes].filter(([, e]) => this.tick - e.tick < ECHO_FRESH);
		const slotN = new Set(this.slots.map((s) => s.n));
		for (const [e, n] of this.crewOf) {
			if (!slotN.has(n) || !live.some(([id]) => id === e)) {
				this.crewOf.delete(e);
			}
		}
		// Crew size by perimeter, at least one per fire while there are Echoes to go round.
		const total = this.slots.reduce((t, s) => t + Math.max(1, s.fire.edge), 0);
		const quota = new Map(this.slots.map((s) => [s.n, Math.max(1, Math.round((live.length * Math.max(1, s.fire.edge)) / total))]));
		const load = new Map(this.slots.map((s) => [s.n, 0]));
		// Keep existing crews where the quota allows (no ping-ponging drones between fires)...
		for (const [e, n] of [...this.crewOf]) {
			if (load.get(n)! < quota.get(n)!) {
				load.set(n, load.get(n)! + 1);
			} else {
				this.crewOf.delete(e);
			}
		}
		// ...then fill the gaps nearest-first.
		const pairs: { e: AgentId; n: number; d: number }[] = [];
		for (const [e, info] of live) {
			if (this.crewOf.has(e)) {
				continue;
			}
			for (const s of this.slots) {
				pairs.push({ e, n: s.n, d: dist(info.pos, s.fire.c) });
			}
		}
		pairs.sort((a, b) => a.d - b.d);
		for (const p of pairs) {
			if (this.crewOf.has(p.e) || load.get(p.n)! >= quota.get(p.n)!) {
				continue;
			}
			this.crewOf.set(p.e, p.n);
			load.set(p.n, load.get(p.n)! + 1);
		}
		// Rounding leftovers go to their nearest fire.
		for (const p of pairs) {
			if (!this.crewOf.has(p.e)) {
				this.crewOf.set(p.e, p.n);
			}
		}
	}

	// Every fire's edge plus the clear cells around it, so drones far away can derive the same edge tasks.
	private pushOutline() {
		const { w, state, ts } = this.map;
		const cells: CellObs[] = [];
		const add = (x: number, y: number) => {
			const i = y * w + x;
			cells.push({ x, y, state: (["unknown", "clear", "fire", "burnt", "village"] as const)[state[i]], ts: ts[i], by: this.id });
		};
		for (const e of this.edges()) {
			if (cells.length >= FIRE_PUSH_CAP) {
				break;
			}
			add(e.x, e.y);
			for (const [dx, dy] of N4) {
				const nx = e.x + dx;
				const ny = e.y + dy;
				if (this.map.inBounds(nx, ny) && state[ny * w + nx] !== FIRE && state[ny * w + nx] !== 0) {
					add(nx, ny);
				}
			}
		}
		if (cells.length) {
			this.emit("map", { cells });
		}
	}
}

// ---------- Water: firefighting drone ----------

const TANK_TICKS = 300; // ~30 s of spray
const REFILL_TICKS = 60;
const STANDOFF = 2; // cells upwind of the aim point
const SPRAY_REACH = 1.5;
const REPICK_EVERY = 30;

type Phase = "standby" | "transit" | "spraying" | "refilling";

export class WaterBrain extends RoleBrain {
	tank = 1;
	aim: Vec | null = null;
	spraying = false;
	private phase: Phase = "standby";
	private aimTick = -1e9;
	private peers = new Map<AgentId, { pos: Vec; tick: number }>();
	private refillPoint: Vec | null = null;

	constructor(
		w: number,
		h: number,
		seed: number,
		radioRange: number,
		readonly sensor: number,
		private readonly refills: Vec[],
		private readonly base: Vec,
		private readonly wind: () => Vec,
	) {
		super(w, h, seed, radioRange);
	}

	info(): UnitInfo {
		return { role: "water", sensor: this.sensor, aim: this.aim ?? undefined, spraying: this.spraying, tank: this.tank, phase: this.phase };
	}

	protected target(sense: Sense): Vec {
		this.trackPeers(sense.inbox);
		this.spraying = false;

		if (this.phase === "refilling" || this.tank <= 0) {
			return this.refill();
		}

		const fireNow = this.aim && this.map.get(Math.round(this.aim.x), Math.round(this.aim.y)) === "fire";
		if (!fireNow || this.tick - this.aimTick > REPICK_EVERY) {
			this.pickAim();
		}
		if (!this.aim) {
			this.phase = "standby";
			return this.base;
		}

		const stand = this.standoff(this.aim);
		if (dist(stand, this.pos) > SPRAY_REACH) {
			this.phase = "transit";
			return stand;
		}
		if (this.phase !== "spraying") {
			this.say(`${this.id}: on station, spraying`);
		}
		this.phase = "spraying";
		this.spraying = true;
		this.tank = Math.max(0, this.tank - 1 / TANK_TICKS);
		if (this.tank === 0) {
			this.say(`${this.id}: tank empty, going to refill`);
			this.phase = "refilling";
			this.refillPoint = null;
		}
		return stand;
	}

	private refill(): Vec {
		this.phase = "refilling";
		this.aim = null;
		const at = (this.refillPoint ??= this.nearestRefill());
		if (dist(at, this.pos) > 1.5) {
			return at;
		}
		this.tank = Math.min(1, this.tank + 1 / REFILL_TICKS);
		if (this.tank >= 1) {
			this.phase = "standby";
			this.refillPoint = null;
		}
		return at;
	}

	private nearestRefill(): Vec {
		let best = this.base;
		let bestD = dist(this.base, this.pos);
		for (const p of this.refills) {
			const d = dist(p, this.pos);
			if (d < bestD) {
				best = p;
				bestD = d;
			}
		}
		return best;
	}

	// Approach from upwind so the smoke blows away from us; with no wind, from where we are.
	private standoff(aim: Vec): Vec {
		const wind = this.wind();
		const m = Math.hypot(wind.x, wind.y);
		const d = m > 0.05 ? { x: -wind.x / m, y: -wind.y / m } : { x: this.pos.x - aim.x, y: this.pos.y - aim.y };
		const k = Math.hypot(d.x, d.y) || 1;
		return this.clamp({ x: aim.x + (d.x / k) * STANDOFF, y: aim.y + (d.y / k) * STANDOFF });
	}

	// Closest edge, buildings first, downwind first, away from the other water drones.
	private pickAim() {
		const edges = this.edges();
		this.aimTick = this.tick;
		if (!edges.length) {
			this.aim = null;
			return;
		}
		const wind = this.wind();
		const fire = this.fireExtent();
		let best: Vec | null = null;
		let bestCost = Infinity;
		for (const e of edges) {
			let cost = dist(e, this.pos);
			if (e.nearBuilding) {
				cost -= 25;
			}
			if (fire) {
				cost -= ((e.x - fire.c.x) * wind.x + (e.y - fire.c.y) * wind.y) * 0.8;
			}
			for (const p of this.peers.values()) {
				if (this.tick - p.tick < 20 && dist(p.pos, e) < 20) {
					cost += 40; // another water drone is working this fire: take a different one
				}
			}
			if (cost < bestCost) {
				bestCost = cost;
				best = { x: e.x, y: e.y };
			}
		}
		this.aim = best;
	}

	private trackPeers(inbox: Msg[]) {
		for (const m of inbox) {
			const origin = originOf(m.id);
			if (m.kind === "heartbeat" && origin !== this.id && origin.startsWith("Water-")) {
				this.peers.set(origin, { pos: (m.body as HeartbeatBody).pos, tick: this.tick });
			}
		}
	}
}
