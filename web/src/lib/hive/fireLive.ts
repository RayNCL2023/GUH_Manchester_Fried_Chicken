// Firebreak in the browser: Ray's headless SimWorld (fire + radio) driving real HiveBrains,
// on terrain rasterised from OpenStreetMap. Roads and water act as firebreaks.
import { HiveBrain } from "@mfc/engine";
import { SimWorld, type SimMetrics } from "@mfc/engine/sim";
import type { CellState, ChatterBody, Control, GoalBody, MsgKind, Vec, WorldView } from "../../../../shared/types";
import { ANTENNA_ID, ANTENNA_M, GroundStation, latLonToCell, type FireCluster, type LinkState, type StationEvent } from "./antenna";
import { FUEL, T, type LoadedArea } from "./osm";
import { bearing } from "./pixel";
import { ALTITUDE_M, SkyBrain, WaterBrain, type Role, type UnitInfo } from "./roles";
import type { Chatter, Live, StatItem } from "./types";

// Real mesh radios (900 MHz / 2.4 GHz with clear line of sight between drones) carry well over a km.
const RADIO_M = 1500;
export const JAM_M = 120;
export const SENSOR = 7;
const TASK_RANGE = 12;
const ECHOES = 10;
const SKIES = 2;
const WATERS = 2;
const SKY_HALF_FOV = (40 * Math.PI) / 180;
const LOOP_TICKS = 6000;
const WIND: Vec = { x: 0.8, y: -0.5 };
// Water: chance per tick each burning cell under the jet is knocked down, and how long soaked fuel resists.
const SPRAY_R = 1.8;
const KNOCKDOWN = 0.22;
const WET_R = 3;
const WET_TICKS = 400;

// One beam per drone pair per tick: the most important thing that went over it.
export type RadioBeam = { from: string; to: string; kind: MsgKind; ok: boolean };
const KIND_RANK: Record<MsgKind, number> = { goal: 5, claim: 4, release: 3, map: 2, chatter: 1, heartbeat: 0 };
// Rolling window for the live packet-loss figure (ticks).
const LOSS_WINDOW = 50;
// Routine traffic to the antenna is drawn at most this often per drone, so the beams stay readable.
const ANTENNA_BEAM_TICKS = 6;

export type Mission = { id: string; text: string; target: Vec; crew: string[]; tick: number; onScene: number };

export type StationSnap = {
	name: string;
	pos: Vec;
	jammed: boolean;
	links: Record<string, LinkState>;
	direct: number;
	relay: number;
	dark: number;
	fireCells: number;
	clusters: FireCluster[];
	events: StationEvent[];
	missions: Mission[];
	lastHeard: Record<string, number>;
};

export type UplinkResult =
	| { ok: true; via: string; crew: string[]; goalId: string }
	| { ok: false; reason: string };

export type FireSnap = {
	view: WorldView;
	units: Record<string, UnitInfo>;
	radio: RadioBeam[];
	terrain: Uint8Array;
	headline: number;
	history: number[];
	stats: StatItem[];
	chatter: Chatter[];
	station: StationSnap | null;
	lossPct: number;
};

export default class FireLive implements Live<FireSnap> {
	private sim!: SimWorld;
	private metrics!: SimMetrics;
	private chatter: Chatter[] = [];
	private history: number[] = [];
	private inspectId: string | null = null;
	private buildingCells: number;
	private wet!: Int32Array;
	private knockedDown = 0;
	private beams = new Map<string, RadioBeam>();
	private everBurned = 0;
	private window: { ok: number; jam: number }[] = [];
	private tickLinks = { ok: 0, jam: 0 };
	private antennaBeamAt = new Map<string, number>();
	private missions: Omit<Mission, "onScene">[] = [];
	readonly station: GroundStation | null;
	readonly radioCells: number;
	readonly skySensor: number;

	constructor(
		private area: LoadedArea,
		private seed = 3,
	) {
		this.buildingCells = area.terrain.reduce((n, t) => n + (t === T.building ? 1 : 0), 0);
		this.radioCells = Math.round(RADIO_M / area.mPerCell);
		this.skySensor = Math.round((ALTITUDE_M.sky * Math.tan(SKY_HALF_FOV)) / area.mPerCell);
		const a = area.antenna;
		this.station = a ? new GroundStation(area, a.name, latLonToCell(area, a.lat, a.lon), Math.round(ANTENNA_M / area.mPerCell)) : null;
		this.reset();
	}

	reset() {
		const { width, height, terrain } = this.area;
		const range = this.radioCells;
		const base = this.baseCell();
		const refills = this.waterCells();
		const roster = [
			...Array.from({ length: ECHOES }, (_, i) => ({ id: `Echo-${i + 1}` })),
			...Array.from({ length: SKIES }, (_, i) => ({ id: `Sky-${i + 1}`, sensorRadius: this.skySensor, speed: 1.6 })),
			...Array.from({ length: WATERS }, (_, i) => ({ id: `Water-${i + 1}`, speed: 0.8 })),
		];
		this.sim = new SimWorld({
			width,
			height,
			agents: roster.length,
			roster,
			seed: this.seed,
			lossPct: 30,
			wind: { ...WIND },
			jamZones: [],
			spread: 0.025,
			sensorRadius: SENSOR,
			sensorSquare: true,
			radioRange: range,
			taskRange: TASK_RANGE,
			makeBrain: (id) => {
				const n = Number(id.split("-")[1]) - 1;
				if (id.startsWith("Sky-")) {
					return new SkyBrain(width, height, this.seed, range, n, SKIES, this.skySensor);
				}
				if (id.startsWith("Water-")) {
					return new WaterBrain(width, height, this.seed, range, SENSOR, refills, base, () => this.sim.cfg.wind);
				}
				return new HiveBrain({ width, height, seed: this.seed, radioRange: range });
			},
		});
		this.wet = new Int32Array(width * height);
		this.knockedDown = 0;
		this.everBurned = 0;
		this.window = [];
		this.missions = [];
		this.antennaBeamAt.clear();
		this.station?.reset();

		// Replace the default map with real terrain: buildings are what the flock protects.
		this.sim.cells = Array.from(terrain, (t): CellState => (t === T.building ? "village" : "clear"));
		this.sim.burnAge.fill(0);

		this.sim.agents.forEach((a, i) => {
			a.pos = { x: base.x + (i % 5), y: base.y - Math.floor(i / 5) };
		});

		this.sim.onLink = (from, to, kind, ok) => {
			this.beam(from, to, kind, ok);
			if (ok) {
				this.tickLinks.ok++;
			} else {
				this.tickLinks.jam++;
			}
		};
		this.sim.onSend = (from, m) => {
			this.toAntenna(from, m.kind);
			if (m.kind !== "chatter") {
				return;
			}
			const line = (m.body as ChatterBody).line;
			this.station?.hearChatter(this.sim.tick, from, line);
			this.chatter.push({ from, line, tick: this.sim.tick });
			if (this.chatter.length > 30) {
				this.chatter.shift();
			}
		};
		this.metrics = this.sim.metrics();
		this.chatter = [];
		this.history = [];
		this.inspectId = null;
	}

	private beam(from: string, to: string, kind: MsgKind, ok: boolean) {
		const key = `${from}>${to}`;
		const prev = this.beams.get(key);
		if (!prev || KIND_RANK[kind] > KIND_RANK[prev.kind] || (ok && !prev.ok)) {
			this.beams.set(key, { from, to, kind, ok });
		}
	}

	// Every transmission is also heard (or not) by the ground station's antenna.
	private toAntenna(from: string, kind: MsgKind) {
		const st = this.station;
		const a = this.sim.agents.find((x) => x.id === from);
		if (!st || !a?.alive) {
			return;
		}
		const path = st.pathTo(a.pos, this.sim.cfg.jamZones);
		if (path === "range") {
			return;
		}
		const ok = path === "ok" && !st.jammed && !this.sim.jammed(a.pos);
		if (ok && Math.random() * 100 < this.sim.cfg.lossPct) {
			return; // lost to noise: nobody sees it
		}
		st.countPacket(ok);
		const tick = this.sim.tick;
		if (KIND_RANK[kind] < KIND_RANK.claim && tick - (this.antennaBeamAt.get(from) ?? -1e9) < ANTENNA_BEAM_TICKS) {
			return;
		}
		this.antennaBeamAt.set(from, tick);
		this.beam(from, ANTENNA_ID, kind, ok);
	}

	// Drone-to-drone links that work right now (both ends outside every jammer, in range).
	private meshLinks(): [string, string][] {
		const s = this.sim;
		const free = s.agents.filter((a) => a.alive && !s.jammed(a.pos));
		const links: [string, string][] = [];
		for (let i = 0; i < free.length; i++) {
			for (let k = i + 1; k < free.length; k++) {
				const a = free[i];
				const b = free[k];
				if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) <= s.cfg.radioRange) {
					links.push([a.id, b.id]);
				}
			}
		}
		return links;
	}

	// Launch from the open ground nearest the bottom-left corner.
	private baseCell(): Vec {
		const { width, height, terrain } = this.area;
		for (let r = 0; r < width; r++) {
			for (let k = 0; k <= r; k++) {
				const x = 2 + k;
				const y = height - 3 - (r - k);
				if (y >= 2 && x < width - 5 && FUEL[terrain[y * width + x]] > 0.3 && terrain[y * width + x] !== T.building) {
					return { x, y };
				}
			}
		}
		return { x: 2, y: height - 3 };
	}

	// Open water the firefighters can refill from (sampled so the list stays short).
	private waterCells(): Vec[] {
		const { width, terrain } = this.area;
		const out: Vec[] = [];
		for (let i = 0; i < terrain.length; i += 7) {
			if (terrain[i] === T.water) {
				out.push({ x: i % width, y: Math.floor(i / width) });
			}
		}
		return out;
	}

	step() {
		const before = this.sim.cells;
		this.beams.clear();
		this.tickLinks = { ok: 0, jam: 0 };
		this.sim.step();
		this.applyFuel(before);
		this.spray();
		this.metrics = this.sim.metrics();
		this.window.push(this.tickLinks);
		if (this.window.length > LOSS_WINDOW) {
			this.window.shift();
		}
		const st = this.station;
		if (st) {
			st.update(this.sim.tick, this.sim.agents, this.meshLinks(), this.sim.cfg.jamZones);
			if (this.sim.tick % 5 === 0) {
				st.updateFire(
					this.sim.tick,
					this.sim.agents.map((a) => ({ id: a.id, map: (a.brain as HiveBrain).map })),
				);
			}
		}

		if (this.sim.tick % 5 === 0) {
			this.history.push(this.metrics.edgeMappedPct);
			if (this.history.length > 150) {
				this.history.shift();
			}
		}
		if (this.sim.tick > LOOP_TICKS) {
			this.reset();
		}
	}

	// The engine's fire physics has no fuel, so the world rejects ignitions on roads and water.
	private applyFuel(before: CellState[]) {
		const after = this.sim.cells;
		const { terrain } = this.area;
		const tick = this.sim.tick;
		for (let i = 0; i < after.length; i++) {
			if (after[i] !== "fire" || before[i] === "fire") {
				continue;
			}
			if (Math.random() > FUEL[terrain[i]] || this.wet[i] > tick) {
				after[i] = before[i];
			} else {
				this.everBurned++;
			}
		}
	}

	// Water drones on station knock down the flames under their jet and soak the fuel around it.
	private spray() {
		const { width, height } = this.area;
		const cells = this.sim.cells;
		const tick = this.sim.tick;
		for (const a of this.sim.agents) {
			const b = a.brain;
			if (!a.alive || !(b instanceof WaterBrain) || !b.spraying || !b.aim) {
				continue;
			}
			const { x: ax, y: ay } = b.aim;
			for (let y = Math.floor(ay - WET_R); y <= ay + WET_R; y++) {
				for (let x = Math.floor(ax - WET_R); x <= ax + WET_R; x++) {
					const d = Math.hypot(x - ax, y - ay);
					if (x < 0 || y < 0 || x >= width || y >= height || d > WET_R) {
						continue;
					}
					const i = y * width + x;
					this.wet[i] = tick + WET_TICKS;
					if (cells[i] === "fire" && d <= SPRAY_R && Math.random() < KNOCKDOWN) {
						cells[i] = "burnt";
						this.knockedDown++;
					}
				}
			}
		}
	}

	ignite(at: Vec) {
		const { width, height, terrain } = this.area;
		const cx = Math.floor(at.x);
		const cy = Math.floor(at.y);
		for (let y = cy - 2; y <= cy + 2; y++) {
			for (let x = cx - 2; x <= cx + 2; x++) {
				const i = y * width + x;
				const out = x < 0 || y < 0 || x >= width || y >= height;
				if (out || Math.hypot(x - cx, y - cy) > 2.2 || FUEL[terrain[i]] === 0) {
					continue;
				}
				if (this.sim.cells[i] === "clear" || this.sim.cells[i] === "village") {
					this.sim.cells[i] = "fire";
					this.sim.burnAge[i] = 0;
					this.everBurned++;
				}
			}
		}
	}

	control(c: Control) {
		const cfg = this.sim.cfg;
		switch (c.type) {
			case "addJam":
				cfg.jamZones.push({ center: c.center, radius: c.radius });
				break;
			case "clearJams":
				cfg.jamZones = [];
				break;
			case "setWind":
				cfg.wind = c.wind;
				break;
			case "setLoss":
				cfg.lossPct = c.pct;
				break;
			case "killAgent":
				this.sim.kill(c.id);
				break;
			case "inspect":
				this.inspectId = c.id;
				break;
			case "goal":
				this.sim.injectGoal(c.body);
				break;
			case "reset":
				this.reset();
				break;
		}
	}

	// Ground control → flock. The order leaves the antenna to one drone it can reach directly, then floods
	// drone to drone like any other goal. Jam the antenna (or every path out of it) and nothing gets through.
	uplink(target: Vec, text: string, opts: { crew?: number; role?: Role | "any" } = {}): UplinkResult {
		const st = this.station;
		if (!st) {
			return { ok: false, reason: "This map has no ground station antenna." };
		}
		if (st.jammed) {
			return { ok: false, reason: "The antenna is jammed. Nothing can be transmitted until the jammer is cleared." };
		}
		const s = this.sim;
		const direct = s.agents.filter((a) => a.alive && st.link.get(a.id) === "direct");
		if (!direct.length) {
			return { ok: false, reason: "No drone has a clear path to the antenna right now, so the order can't be sent." };
		}
		const d = (p: Vec, q: Vec) => Math.hypot(p.x - q.x, p.y - q.y);
		const via = direct.reduce((b, a) => (d(a.pos, st.pos) < d(b.pos, st.pos) ? a : b));
		const role = opts.role ?? "echo";
		const pool = s.agents.filter((a) => {
			if (!a.alive || st.link.get(a.id) === "dark") {
				return false;
			}
			return role === "any" || a.id.toLowerCase().startsWith(role);
		});
		const crew = pool
			.sort((a, b) => d(a.pos, target) - d(b.pos, target))
			.slice(0, Math.max(1, Math.min(pool.length, opts.crew ?? 4)))
			.map((a) => a.id);
		const body: GoalBody = { id: st.nextGoalId(), text, target: { x: target.x, y: target.y }, radius: 6, priority: 3, assignees: crew };
		via.inbox.push({ id: `${body.id}~up`, from: ANTENNA_ID, kind: "goal", ttl: 0, ts: s.tick, body });
		this.beam(ANTENNA_ID, via.id, "goal", true);
		st.lastUplink = { tick: s.tick, via: via.id, goal: body };
		st.event(s.tick, `Order uplinked via ${via.id}: ${text} (${crew.join(", ")}) ${st.describe(target.x, target.y)}`);
		this.missions.push({ id: body.id, text, target: body.target!, crew, tick: s.tick });
		if (this.missions.length > 6) {
			this.missions.shift();
		}
		return { ok: true, via: via.id, crew, goalId: body.id };
	}

	private lossNow() {
		const ok = this.window.reduce((n, w) => n + w.ok, 0);
		const jam = this.window.reduce((n, w) => n + w.jam, 0);
		const l = Math.min(0.99, this.sim.cfg.lossPct / 100);
		// Noise drops happen before the radio hook sees them, so recover them from the configured rate.
		const clean = ok / (1 - l);
		const total = clean + jam;
		return total ? Math.round(((total - ok) / total) * 100) : this.sim.cfg.lossPct;
	}

	rotateWind() {
		const w = this.sim.cfg.wind;
		const a = Math.atan2(w.y, w.x) + Math.PI / 4;
		const m = Math.hypot(w.x, w.y);
		this.control({ type: "setWind", wind: { x: Math.cos(a) * m, y: Math.sin(a) * m } });
	}

	private stationSnap(): StationSnap | null {
		const st = this.station;
		if (!st) {
			return null;
		}
		const links = Object.fromEntries(st.link);
		const count = (k: LinkState) => Object.values(links).filter((v) => v === k).length;
		const pos = (id: string) => this.sim.agents.find((a) => a.id === id);
		return {
			name: st.name,
			pos: st.pos,
			jammed: st.jammed,
			links,
			direct: count("direct"),
			relay: count("relay"),
			// Only drones it once heard and now can't: the station has no idea about the dead ones' fate.
			dark: this.sim.agents.length - count("direct") - count("relay"),
			fireCells: st.fireCells,
			clusters: st.clusters.slice(0, 5),
			events: st.events.slice(-30),
			missions: this.missions.map((m) => ({
				...m,
				onScene: m.crew.filter((id) => {
					const a = pos(id);
					return a?.alive && Math.hypot(a.pos.x - m.target.x, a.pos.y - m.target.y) <= 8;
				}).length,
			})),
			lastHeard: Object.fromEntries(st.lastHeard),
		};
	}

	private stats(alive: number, spraying: number, lost: number): StatItem[] {
		const s = this.sim;
		const m = this.metrics;
		const st = this.stationSnap();
		const burning = s.cells.reduce((n, c) => n + (c === "fire" ? 1 : 0), 0);
		const loss = this.lossNow();
		const jammed = s.agents.filter((a) => a.alive && s.jammed(a.pos)).length;
		const reporting = st ? st.direct + st.relay : 0;
		const out = this.everBurned ? Math.round(((this.everBurned - burning) / this.everBurned) * 100) : null;
		return [
			{
				label: "Fire edge mapped",
				value: m.edgeCells ? Math.round(m.edgeMappedPct) : "–",
				unit: m.edgeCells ? "%" : undefined,
				tone: "flock",
				hero: true,
				hint: m.edgeCells ? `even with ${loss}% of packets lost` : "Start a fire to see the flock map it",
			},
			{
				label: "Packets lost on air",
				value: loss,
				unit: "%",
				tone: "bad",
				hero: true,
				hint: `${s.cfg.lossPct}% noise${s.cfg.jamZones.length ? ` + ${s.cfg.jamZones.length} jammer${s.cfg.jamZones.length > 1 ? "s" : ""}` : ""} · ${jammed} drone${jammed === 1 ? "" : "s"} inside one`,
			},
			st
				? {
						label: "Reporting to ground",
						value: alive ? Math.round((reporting / alive) * 100) : 0,
						unit: "%",
						tone: st.jammed ? "bad" : "good",
						hero: true,
						hint: st.jammed ? "Antenna jammed: the flock carries on alone" : `${st.direct} direct · ${st.relay} via mesh relay · ${Math.max(0, alive - reporting)} dark`,
					}
				: {
						label: "Mesh links up",
						value: this.meshLinks().length,
						tone: "good",
						hero: true,
						hint: "No ground station on searched maps",
					},
			{
				label: "Fire put out",
				value: out ?? "–",
				unit: out === null ? undefined : "%",
				tone: "good",
				hero: true,
				hint: out === null ? "Nothing burning yet" : `${burning} cells still burning · ${this.knockedDown} knocked down by water`,
			},
			{
				label: "Buildings saved",
				value: this.buildingCells ? 100 - Math.round((lost / this.buildingCells) * 100) : 100,
				unit: "%",
				tone: "warn",
				hero: true,
				hint: `${lost} building cells burnt`,
			},
			{ label: "Elapsed", value: Math.floor(s.tick / 10), unit: "s" },
			{ label: "Drones up", value: alive, unit: `/ ${s.agents.length}` },
			{ label: "Water drones spraying", value: spraying, unit: `/ ${WATERS}` },
			{ label: "Messages delivered", value: m.messagesDelivered.toLocaleString("en-GB") },
			{ label: "Duplicate claims", value: m.duplicateClaims },
			{ label: "Wind", value: bearing(s.cfg.wind), unit: "°" },
		];
	}

	snapshot(): FireSnap {
		const s = this.sim;
		const { width, height } = s.cfg;
		const m = this.metrics;
		const alive = s.agents.filter((a) => a.alive);
		const brain = (a: (typeof s.agents)[number]) => a.brain as HiveBrain;
		const links = this.meshLinks();

		const insp = alive.find((a) => a.id === this.inspectId);
		const { terrain } = this.area;
		const lost = s.cells.reduce((n, c, i) => n + (terrain[i] === T.building && c !== "village" ? 1 : 0), 0);

		const units: Record<string, UnitInfo> = {};
		for (const a of s.agents) {
			const b = a.brain;
			units[a.id] = b instanceof SkyBrain || b instanceof WaterBrain ? b.info() : { role: "echo", sensor: SENSOR };
		}
		const spraying = s.agents.filter((a) => a.alive && a.brain instanceof WaterBrain && a.brain.spraying).length;

		return {
			terrain,
			units,
			radio: [...this.beams.values()],
			view: {
				tick: s.tick,
				scenario: "fire",
				width,
				height,
				cells: s.cells.slice(),
				agents: s.agents.map((a) => ({
					id: a.id,
					pos: { ...a.pos },
					alive: a.alive,
					jammed: a.alive && s.jammed(a.pos),
					isPhone: false,
					claim: a.claim,
					mode: a.alive ? brain(a).debug().mode : "down",
					knownPct: Math.round(brain(a).map.knownPct()),
				})),
				links,
				jamZones: s.cfg.jamZones,
				wind: s.cfg.wind,
				metrics: {
					edgeMappedPct: Math.round(m.edgeMappedPct),
					msgLossPct: s.cfg.lossPct,
					aliveAgents: alive.length,
				},
				recentChatter: this.chatter.slice(-20),
				inspected: insp && { id: insp.id, map: brain(insp).map.encode() },
			},
			headline: m.edgeCells ? Math.round(m.edgeMappedPct) : 0,
			history: [...this.history],
			chatter: this.chatter.slice(-8).reverse(),
			stats: this.stats(alive.length, spraying, lost),
			station: this.stationSnap(),
			lossPct: s.cfg.lossPct,
		};
	}
}
