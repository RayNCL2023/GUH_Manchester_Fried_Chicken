// Firebreak in the browser: Ray's headless SimWorld (fire + radio) driving real HiveBrains,
// on terrain rasterised from OpenStreetMap. Roads and water act as firebreaks.
import { HiveBrain } from "@mfc/engine";
import { SimWorld, type SimMetrics } from "@mfc/engine/sim";
import type { CellState, ChatterBody, Control, Vec, WorldView } from "../../../../shared/types";
import { FUEL, T, type LoadedArea } from "./osm";
import { bearing } from "./pixel";
import type { Chatter, Live, StatItem } from "./types";

const RANGE = 12;
const SENSOR = 7;
const AGENTS = 12;
const LOOP_TICKS = 6000;
const WIND: Vec = { x: 0.8, y: -0.5 };

export type FireSnap = {
	view: WorldView;
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
	private goalSeq = 0;
	private buildingCells: number;

	constructor(
		private area: LoadedArea,
		private seed = 3,
	) {
		this.buildingCells = area.terrain.reduce((n, t) => n + (t === T.building ? 1 : 0), 0);
		this.reset();
	}

	reset() {
		const { width, height, terrain } = this.area;
		this.sim = new SimWorld({
			width,
			height,
			agents: AGENTS,
			seed: this.seed,
			lossPct: 30,
			wind: { ...WIND },
			jamZones: [],
			spread: 0.045,
			sensorRadius: SENSOR,
			radioRange: RANGE,
			makeBrain: () => new HiveBrain({ width, height, seed: this.seed, radioRange: RANGE }),
		});

		// Replace the default map with real terrain: buildings are what the flock protects.
		this.sim.cells = Array.from(terrain, (t): CellState => (t === T.building ? "village" : "clear"));
		this.sim.burnAge.fill(0);

		const base = this.baseCell();
		this.sim.agents.forEach((a, i) => {
			a.pos = { x: base.x + (i % 5), y: base.y - Math.floor(i / 5) };
		});

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

	step() {
		const before = this.sim.cells;
		this.sim.step();
		this.applyFuel(before);
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
		for (let i = 0; i < after.length; i++) {
			if (after[i] === "fire" && before[i] !== "fire" && Math.random() > FUEL[terrain[i]]) {
				after[i] = before[i];
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

	// Goal at the standing building closest to the fire. It reaches ONE drone; the rest hear it by gossip.
	protectBuildings() {
		const { width } = this.area;
		const cells = this.sim.cells;
		const fire = cells.flatMap((c, i) => (c === "fire" ? [i] : []));
		const centre = fire.length
			? { x: fire.reduce((s, i) => s + (i % width), 0) / fire.length, y: fire.reduce((s, i) => s + Math.floor(i / width), 0) / fire.length }
			: { x: width / 2, y: this.area.height / 2 };

		let target: Vec | null = null;
		let best = Infinity;
		cells.forEach((c, i) => {
			const p = { x: i % width, y: Math.floor(i / width) };
			const d = Math.hypot(p.x - centre.x, p.y - centre.y);
			if (c === "village" && d < best) {
				best = d;
				target = p;
			}
		});
		if (!target) {
			return;
		}

		this.control({
			type: "goal",
			body: { id: `goal-${++this.goalSeq}`, text: "Protect the buildings", target, radius: 8, priority: 3 },
		});
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

		return {
			terrain,
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
