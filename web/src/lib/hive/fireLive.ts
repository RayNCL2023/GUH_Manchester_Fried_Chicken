// Firebreak in the browser: Ray's headless SimWorld (fire + radio) driving real HiveBrains.
import { HiveBrain } from "@mfc/engine";
import { SimWorld, type SimMetrics } from "@mfc/engine/sim";
import type { ChatterBody, Control, Vec, WorldView } from "../../../../shared/types";
import { bearing } from "./pixel";
import type { Chatter, Live, StatItem } from "./types";

const RANGE = 8;
const LOOP_TICKS = 3000;
const WIND: Vec = { x: -0.6, y: 0.75 };
const JAMS = [{ center: { x: 22, y: 20 }, radius: 4 }];

export type FireSnap = {
	view: WorldView;
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

	constructor(private seed = 3) {
		this.reset();
	}

	reset() {
		this.sim = new SimWorld({
			seed: this.seed,
			lossPct: 30,
			wind: { ...WIND },
			jamZones: JAMS.map((j) => ({ center: { ...j.center }, radius: j.radius })),
			sensorRadius: 5,
			radioRange: RANGE,
			makeBrain: () => new HiveBrain({ seed: this.seed, radioRange: RANGE }),
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

	step() {
		this.sim.step();
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

	// The goal reaches ONE drone; the rest only hear it by gossip.
	protectVillage() {
		const { width } = this.sim.cfg;
		const village = this.sim.cells.flatMap((c, i) => (c === "village" ? [{ x: i % width, y: Math.floor(i / width) }] : []));
		const target = {
			x: village.reduce((s, p) => s + p.x, 0) / (village.length || 1),
			y: village.reduce((s, p) => s + p.y, 0) / (village.length || 1),
		};
		this.control({
			type: "goal",
			body: { id: `goal-${++this.goalSeq}`, text: "Protect the village", target, radius: 8, priority: 3 },
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
		const burning = s.cells.filter((c) => c === "fire").length;

		return {
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
			headline: Math.round(m.edgeMappedPct),
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
				{ label: "Burning cells", value: burning, unit: `/ ${m.edgeCells} edge` },
			],
		};
	}
}
