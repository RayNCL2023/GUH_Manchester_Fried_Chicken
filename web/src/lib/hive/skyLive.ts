// Flock show: real HiveBrains in "lights" mode claim pixels of a picture in the sky.
// The world only simulates flight and radio (range, loss, jamming). It never assigns slots.
import { HiveBrain } from "@mfc/engine";
import type { Action, AgentId, ChatterBody, Msg, Sense, Task, Vec } from "../../../../shared/types";
import { ART_COLORS, PICTURES, fitArt } from "./pixel";
import type { Chatter, Live, StatItem } from "./types";

export const SKY_W = 64;
export const SKY_H = 36;
const DRONES = 64;
const RANGE = 9;
const SPEED = 0.7;
const GROUND = 33;
const RESERVE_Y = 27;
const UNLIT = "#000000";

type Drone = {
	id: AgentId;
	pos: Vec;
	alive: boolean;
	jammed: boolean;
	brain: HiveBrain;
	inbox: Msg[];
	claim: string | null;
	color: string;
	mission: number; // the picture this drone last heard about
};

export type SkySnap = {
	tick: number;
	drones: { id: AgentId; pos: Vec; alive: boolean; jammed: boolean; color: string; onSlot: boolean }[];
	links: [Vec, Vec][];
	jams: { center: Vec; radius: number }[];
	targets: { pos: Vec; color: string }[];
	mission: number;
	headline: number;
	history: number[];
	stats: StatItem[];
	chatter: Chatter[];
};

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export default class SkyLive implements Live<SkySnap> {
	tick = 0;
	mission = 0;
	lossPct = 20;
	jams: { center: Vec; radius: number }[] = [];
	private drones: Drone[] = [];
	private links: [Drone, Drone][] = [];
	private chatter: Chatter[] = [];
	private history: number[] = [];
	private slotCache = new Map<string, { tasks: Task[]; size: string }>();
	private formed = 0;
	private rand = Math.random;

	constructor(private seed = 5) {
		this.reset();
	}

	reset() {
		this.tick = 0;
		this.mission = 0;
		this.jams = [];
		this.chatter = [];
		this.history = [];
		this.drones = Array.from({ length: DRONES }, (_, i) => {
			const id = `Echo-${i + 1}`;
			const brain = new HiveBrain({ width: SKY_W, height: SKY_H, seed: this.seed, radioRange: RANGE });
			brain.init(id, "lights");
			return {
				id,
				pos: { x: 3 + (i % 16) * 3.8, y: 30 + Math.floor(i / 16) * 1.1 },
				alive: true,
				jammed: false,
				brain,
				inbox: [],
				claim: null,
				color: UNLIT,
				mission: 0,
			};
		});
	}

	// Picture pixels (value 2) plus hover slots for spare drones (value 0.5).
	private slots(mission: number, alive: number) {
		const key = `${mission}:${alive}`;
		const cached = this.slotCache.get(key);
		if (cached) {
			return cached;
		}

		const art = fitArt(PICTURES[mission].art, alive);
		const w = art[0].length;
		const h = art.length;
		const s = Math.min(3, 46 / w, 22 / h);
		const tasks: Task[] = [];

		art.forEach((row, y) =>
			[...row].forEach((ch, x) => {
				if (ch === ".") {
					return;
				}
				tasks.push({
					id: `slot:${mission}.${w}x${h}:${x}:${y}`,
					pos: { x: SKY_W / 2 + (x - (w - 1) / 2) * s, y: 13 + (y - (h - 1) / 2) * s },
					kind: "slot",
					value: 2,
					color: ART_COLORS[ch],
				});
			}),
		);

		const spare = Math.max(0, alive - tasks.length) + 2;
		for (let k = 0; k < spare; k++) {
			tasks.push({
				id: `slot:reserve:${k}`,
				pos: { x: 3 + (k * (SKY_W - 6)) / Math.max(1, spare - 1), y: RESERVE_Y },
				kind: "slot",
				value: 0.5,
				color: UNLIT,
			});
		}

		const out = { tasks, size: `${w}×${h}` };
		this.slotCache.set(key, out);
		return out;
	}

	private inJam(p: Vec) {
		return this.jams.some((j) => dist(p, j.center) <= j.radius);
	}

	step() {
		this.tick++;
		const alive = this.drones.filter((d) => d.alive);

		for (const d of this.drones) {
			if (!d.alive) {
				d.pos.y = Math.min(GROUND, d.pos.y + 0.6);
				continue;
			}
			d.jammed = this.inJam(d.pos);
			if (!d.jammed) {
				d.mission = this.mission;
			}
		}

		const neighbours = new Map<AgentId, AgentId[]>(alive.map((d) => [d.id, []]));
		this.links = [];
		for (let i = 0; i < alive.length; i++) {
			for (let k = i + 1; k < alive.length; k++) {
				const a = alive[i];
				const b = alive[k];
				if (a.jammed || b.jammed || dist(a.pos, b.pos) > RANGE) {
					continue;
				}
				this.links.push([a, b]);
				neighbours.get(a.id)!.push(b.id);
				neighbours.get(b.id)!.push(a.id);
			}
		}

		const actions = new Map<AgentId, Action>();
		for (const d of alive) {
			const sense: Sense = {
				tick: this.tick,
				scenario: "lights",
				self: { id: d.id, pos: { ...d.pos }, alive: true, jammed: d.jammed, isPhone: false },
				nearbyCells: [],
				neighbours: neighbours.get(d.id)!,
				inbox: d.inbox,
				tasks: this.slots(d.mission, alive.length).tasks,
				clockMs: this.tick * 100,
			};
			d.inbox = [];
			actions.set(d.id, d.brain.step(sense));
		}

		for (const d of alive) {
			const act = actions.get(d.id)!;
			d.claim = act.claimed ?? null;
			d.color = act.display?.color ?? UNLIT;
			this.route(d, act, neighbours.get(d.id)!);
			this.move(d, act.moveTo);
		}

		this.formed = this.formedPct(alive);
		if (this.tick % 5 === 0) {
			this.history.push(this.formed);
			if (this.history.length > 150) {
				this.history.shift();
			}
		}
	}

	private route(d: Drone, act: Action, neighbours: AgentId[]) {
		for (const m of act.send ?? []) {
			if (m.kind === "chatter") {
				this.chatter.push({ from: d.id, line: (m.body as ChatterBody).line, tick: this.tick });
				if (this.chatter.length > 30) {
					this.chatter.shift();
				}
			}
			for (const id of neighbours) {
				if (this.rand() * 100 < this.lossPct) {
					continue;
				}
				this.drones.find((x) => x.id === id)!.inbox.push({ ...m, from: d.id });
			}
		}
	}

	private move(d: Drone, to?: Vec) {
		if (!to) {
			return;
		}
		const dd = dist(d.pos, to);
		const k = dd > SPEED ? SPEED / dd : 1;
		d.pos.x = Math.max(0, Math.min(SKY_W - 1, d.pos.x + (to.x - d.pos.x) * k));
		d.pos.y = Math.max(0, Math.min(SKY_H - 1, d.pos.y + (to.y - d.pos.y) * k));
	}

	private onSlot(d: Drone, tasks: Task[]) {
		const t = tasks.find((x) => x.id === d.claim);
		return !!t && dist(d.pos, t.pos) <= 1.5;
	}

	private formedPct(alive: Drone[]) {
		const { tasks } = this.slots(this.mission, alive.length);
		const picture = tasks.filter((t) => t.color !== UNLIT);
		const done = picture.filter((t) =>
			alive.some((d) => d.claim === t.id && !d.jammed && dist(d.pos, t.pos) <= 1.5),
		).length;
		return picture.length ? Math.round((done / picture.length) * 100) : 0;
	}

	kill(id: AgentId) {
		const d = this.drones.find((x) => x.id === id);
		if (d) {
			d.alive = false;
			d.claim = null;
		}
	}

	addJam(center: Vec, radius: number) {
		this.jams.push({ center, radius });
	}

	clearJams() {
		this.jams = [];
	}

	setMission(i: number) {
		this.mission = i % PICTURES.length;
	}

	snapshot(): SkySnap {
		const alive = this.drones.filter((d) => d.alive);
		const { tasks, size } = this.slots(this.mission, alive.length);
		const claims = new Map<string, number>();
		for (const d of alive) {
			if (d.claim) {
				claims.set(d.claim, (claims.get(d.claim) ?? 0) + 1);
			}
		}
		const dupes = [...claims.values()].filter((n) => n > 1).length;
		const lit = alive.filter((d) => d.color !== UNLIT).length;

		return {
			tick: this.tick,
			drones: this.drones.map((d) => ({
				id: d.id,
				pos: { ...d.pos },
				alive: d.alive,
				jammed: d.alive && d.jammed,
				color: d.color,
				onSlot: this.onSlot(d, this.slots(d.mission, alive.length).tasks),
			})),
			links: this.links.map(([a, b]) => [{ ...a.pos }, { ...b.pos }]),
			jams: this.jams,
			targets: tasks.filter((t) => t.color !== UNLIT).map((t) => ({ pos: t.pos, color: t.color! })),
			mission: this.mission,
			headline: this.formed,
			history: [...this.history],
			chatter: this.chatter.slice(-8).reverse(),
			stats: [
				{ label: "Elapsed", value: Math.floor(this.tick / 10), unit: "s" },
				{ label: "Flock alive", value: alive.length, unit: `/ ${DRONES}` },
				{ label: "Lights on", value: lit },
				{ label: "Resolution", value: size },
				{ label: "Radio links", value: this.links.length },
				{ label: "Jammed", value: alive.filter((d) => d.jammed).length },
				{ label: "Duplicate claims", value: dupes },
				{ label: "Message loss", value: this.lossPct, unit: "%" },
			],
		};
	}
}
