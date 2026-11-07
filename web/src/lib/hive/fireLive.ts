// Firebreak in the browser: Ray's headless SimWorld (fire + radio) driving real HiveBrains,
// on terrain rasterised from OpenStreetMap. Roads and water act as firebreaks.
import { HiveBrain } from "@mfc/engine";
import { SimWorld, type SimMetrics } from "@mfc/engine/sim";
import type { CellState, ChatterBody, Control, MsgKind, Vec, WorldView } from "../../../../shared/types";
import { FUEL, T, type LoadedArea } from "./osm";
import { bearing } from "./pixel";
import { ALTITUDE_M, SkyBrain, WaterBrain, type UnitInfo } from "./roles";
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

export type FireSnap = {
	view: WorldView;
	units: Record<string, UnitInfo>;
	radio: RadioBeam[];
	terrain: Uint8Array;
	headline: number;
	history: number[];
	stats: StatItem[];
	chatter: Chatter[];
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
	readonly radioCells: number;
	readonly skySensor: number;

	constructor(
		private area: LoadedArea,
		private seed = 3,
	) {
		this.buildingCells = area.terrain.reduce((n, t) => n + (t === T.building ? 1 : 0), 0);
		this.radioCells = Math.round(RADIO_M / area.mPerCell);
		this.skySensor = Math.round((ALTITUDE_M.sky * Math.tan(SKY_HALF_FOV)) / area.mPerCell);
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

		// Replace the default map with real terrain: buildings are what the flock protects.
		this.sim.cells = Array.from(terrain, (t): CellState => (t === T.building ? "village" : "clear"));
		this.sim.burnAge.fill(0);

		this.sim.agents.forEach((a, i) => {
			a.pos = { x: base.x + (i % 5), y: base.y - Math.floor(i / 5) };
		});

		this.sim.onLink = (from, to, kind, ok) => {
			const key = `${from}>${to}`;
			const prev = this.beams.get(key);
			if (!prev || KIND_RANK[kind] > KIND_RANK[prev.kind] || (ok && !prev.ok)) {
				this.beams.set(key, { from, to, kind, ok });
			}
		};
		this.sim.onSend = (from, m) => {
			if (m.kind !== "chatter") {
				return;
			}
			this.chatter.push({ from, line: (m.body as ChatterBody).line, tick: this.sim.tick });
			if (this.chatter.length > 30) {
				this.chatter.shift();
			}
		};
		this.metrics = this.sim.metrics();
		this.chatter = [];
		this.history = [];
		this.inspectId = null;
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
		this.sim.step();
		this.applyFuel(before);
		this.spray();
		this.metrics = this.sim.metrics();

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
			if (after[i] === "fire" && before[i] !== "fire" && (Math.random() > FUEL[terrain[i]] || this.wet[i] > tick)) {
				after[i] = before[i];
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

	rotateWind() {
		const w = this.sim.cfg.wind;
		const a = Math.atan2(w.y, w.x) + Math.PI / 4;
		const m = Math.hypot(w.x, w.y);
		this.control({ type: "setWind", wind: { x: Math.cos(a) * m, y: Math.sin(a) * m } });
	}

	snapshot(): FireSnap {
		const s = this.sim;
		const { width, height, radioRange } = s.cfg;
		const m = this.metrics;
		const alive = s.agents.filter((a) => a.alive);
		const brain = (a: (typeof s.agents)[number]) => a.brain as HiveBrain;
		const free = alive.filter((a) => !s.jammed(a.pos));

		const links: [string, string][] = [];
		for (let i = 0; i < free.length; i++) {
			for (let k = i + 1; k < free.length; k++) {
				const a = free[i];
				const b = free[k];
				if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) <= radioRange) {
					links.push([a.id, b.id]);
				}
			}
		}

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
			stats: [
				{ label: "Elapsed", value: Math.floor(s.tick / 10), unit: "s" },
				{ label: "Flock alive", value: alive.length, unit: `/ ${s.agents.length}` },
				{ label: "Avg map known", value: Math.round(m.avgKnownPct), unit: "%" },
				{ label: "Messages sent", value: m.messagesSent.toLocaleString("en-GB") },
				{ label: "Duplicate claims", value: m.duplicateClaims },
				{ label: "Message loss", value: s.cfg.lossPct, unit: "%" },
				{ label: "Water drones spraying", value: spraying, unit: `/ ${WATERS}` },
				{ label: "Fire knocked down", value: this.knockedDown, unit: "cells" },
				{ label: "Wind bearing", value: bearing(s.cfg.wind), unit: "°" },
				{
					label: "Buildings lost",
					value: this.buildingCells ? Math.round((lost / this.buildingCells) * 100) : 0,
					unit: "%",
				},
			],
		};
	}
}
