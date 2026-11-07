// Flock show: real HiveBrains in "lights" mode claim moving slots of a choreographed show.
// The world only simulates flight and radio. It never assigns slots.
//
// - New shows leave a ground station and spread drone to drone over the radio (gossip).
// - Jamming shrinks radio range rather than killing it: close neighbours can still whisper.
// - Choreography is a function of (show, start tick, shared clock), so a drone that can't hear
//   anyone keeps dancing its last show in sync instead of freezing.
import { HiveBrain } from "@mfc/engine";
import type { Action, AgentId, ChatterBody, Msg, Sense, Task, Vec } from "../../../../shared/types";
import { SHOWS, type Layout } from "./shows";
import type { Chatter, Live, StatItem } from "./types";

export const SKY_W = 96;
export const SKY_H = 54;
export const STATION: Vec = { x: SKY_W / 2, y: 51 };
const DRONES = 64;
const RANGE = 14;
const STATION_RANGE = 24; // ground station has a bigger mast than a drone
const JAM_RANGE = 6; // jamming shrinks range, it does not kill it
const SPEED = 1.4;
const GROUND = 50;
const RESERVE_Y = 43;
const GOSSIP_EVERY = 3;
const AUTOPLAY_TICKS = 180;
const UNLIT = "#000000";

type Mission = { seq: number; show: number; start: number };

type Drone = {
	id: AgentId;
	pos: Vec;
	alive: boolean;
	jammed: boolean;
	brain: HiveBrain;
	inbox: Msg[];
	claim: string | null;
	color: string;
	mission: Mission;
	heardAt: number;
};

export type SkySnap = {
	tick: number;
	drones: {
		id: AgentId;
		pos: Vec;
		alive: boolean;
		jammed: boolean;
		color: string;
		fresh: boolean; // just heard a new show
		stale: boolean; // still dancing an older show
	}[];
	links: [Vec, Vec][];
	jams: { center: Vec; radius: number }[];
	targets: { pos: Vec; color: string }[];
	show: number;
	autoplay: boolean;
	transmitting: boolean;
	headline: number;
	history: number[];
	stats: StatItem[];
	chatter: Chatter[];
	lossPct: number;
};

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export default class SkyLive implements Live<SkySnap> {
	tick = 0;
	lossPct = 20;
	autoplay = true;
	jams: { center: Vec; radius: number }[] = [];
	private current: Mission = { seq: 0, show: 0, start: 0 };
	private drones: Drone[] = [];
	private links: [Drone, Drone][] = [];
	private chatter: Chatter[] = [];
	private history: number[] = [];
	private layouts = new Map<string, Layout>();
	private tasksNow = new Map<number, Task[]>();
	private formed = 0;
	private rand = Math.random;

	constructor(private seed = 5) {
		this.reset();
	}

	reset() {
		this.tick = 0;
		this.current = { seq: 0, show: 0, start: 0 };
		this.jams = [];
		this.chatter = [];
		this.history = [];
		this.layouts.clear();
		this.drones = Array.from({ length: DRONES }, (_, i) => {
			const id = `Echo-${i + 1}`;
			const brain = new HiveBrain({ width: SKY_W, height: SKY_H, seed: this.seed, radioRange: RANGE });
			brain.init(id, "lights");
			return {
				id,
				pos: { x: 4 + (i % 16) * 5.8, y: 45 + Math.floor(i / 16) * 1.6 },
				alive: true,
				jammed: false,
				brain,
				inbox: [],
				claim: null,
				color: UNLIT,
				mission: { ...this.current },
				heardAt: 0,
			};
		});
	}

	launch(show: number) {
		this.current = { seq: this.current.seq + 1, show: show % SHOWS.length, start: this.tick };
	}

	// ---------- slots ----------

	private layout(m: Mission, alive: number) {
		const key = `${m.seq}:${alive}`;
		let l = this.layouts.get(key);
		if (!l) {
			l = SHOWS[m.show].layout(alive);
			this.layouts.set(key, l);
		}
		return l;
	}

	// Slot positions right now, from the drone's own copy of the show and the shared clock.
	private tasksFor(m: Mission, alive: number): Task[] {
		const cached = this.tasksNow.get(m.seq);
		if (cached) {
			return cached;
		}

		const show = SHOWS[m.show];
		const { slots, size } = this.layout(m, alive);
		const t = (this.tick - m.start) / 10;
		const tasks: Task[] = slots.map((s, i) => ({
			id: `slot:${m.seq}:${size}:${i}`,
			pos: show.move(s, t),
			kind: "slot",
			value: 2,
			color: show.tint?.(s, i, t) ?? s.color,
		}));

		const spare = Math.max(0, alive - slots.length) + 2;
		for (let k = 0; k < spare; k++) {
			tasks.push({
				id: `slot:reserve:${k}`,
				// Spares hover in a tight row above the station, in radio reach of each other.
				pos: { x: SKY_W / 2 + (k - (spare - 1) / 2) * 3.5, y: RESERVE_Y },
				kind: "slot",
				value: 0.5,
				color: UNLIT,
			});
		}

		this.tasksNow.set(m.seq, tasks);
		return tasks;
	}

	// ---------- radio ----------

	private inJam(p: Vec) {
		return this.jams.some((j) => dist(p, j.center) <= j.radius);
	}

	private range(a: Drone, b: Drone) {
		return a.jammed || b.jammed ? JAM_RANGE : RANGE;
	}

	private adopt(d: Drone, m: Mission) {
		if (m.seq <= d.mission.seq) {
			return;
		}
		d.mission = m;
		d.heardAt = this.tick;
	}

	step() {
		this.tick++;
		this.tasksNow.clear();
		if (this.autoplay && this.tick - this.current.start > AUTOPLAY_TICKS) {
			this.launch(this.current.show + 1);
		}

		const alive = this.drones.filter((d) => d.alive);
		for (const d of this.drones) {
			if (!d.alive) {
				d.pos.y = Math.min(GROUND, d.pos.y + 0.6);
				continue;
			}
			d.jammed = this.inJam(d.pos);
		}

		const neighbours = new Map<AgentId, Drone[]>(alive.map((d) => [d.id, []]));
		this.links = [];
		for (let i = 0; i < alive.length; i++) {
			for (let k = i + 1; k < alive.length; k++) {
				const a = alive[i];
				const b = alive[k];
				if (dist(a.pos, b.pos) > this.range(a, b)) {
					continue;
				}
				this.links.push([a, b]);
				neighbours.get(a.id)!.push(b);
				neighbours.get(b.id)!.push(a);
			}
		}

		this.spreadMission(alive, neighbours);

		const actions = new Map<AgentId, Action>();
		for (const d of alive) {
			const sense: Sense = {
				tick: this.tick,
				scenario: "lights",
				self: { id: d.id, pos: { ...d.pos }, alive: true, jammed: d.jammed, isPhone: false },
				nearbyCells: [],
				neighbours: neighbours.get(d.id)!.map((n) => n.id),
				inbox: d.inbox,
				tasks: this.tasksFor(d.mission, alive.length),
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

	// The station reaches drones in range; everyone else hears the new show from a neighbour.
	private spreadMission(alive: Drone[], neighbours: Map<AgentId, Drone[]>) {
		for (const d of alive) {
			if (!d.jammed && dist(d.pos, STATION) <= STATION_RANGE) {
				this.adopt(d, this.current);
			}
		}
		if (this.tick % GOSSIP_EVERY !== 0) {
			return;
		}

		const heard: [Drone, Mission][] = [];
		for (const d of alive) {
			for (const n of neighbours.get(d.id)!) {
				if (n.mission.seq > d.mission.seq && this.rand() * 100 >= this.lossPct) {
					heard.push([d, n.mission]);
				}
			}
		}
		for (const [d, m] of heard) {
			this.adopt(d, m);
		}
	}

	private route(d: Drone, act: Action, neighbours: Drone[]) {
		for (const m of act.send ?? []) {
			if (m.kind === "chatter") {
				this.chatter.push({ from: d.id, line: (m.body as ChatterBody).line, tick: this.tick });
				if (this.chatter.length > 30) {
					this.chatter.shift();
				}
			}
			for (const n of neighbours) {
				if (this.rand() * 100 < this.lossPct) {
					continue;
				}
				n.inbox.push({ ...m, from: d.id });
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

	private formedPct(alive: Drone[]) {
		const tasks = this.tasksFor(this.current, alive.length).filter((t) => t.color !== UNLIT);
		const done = tasks.filter((t) => alive.some((d) => d.claim === t.id && dist(d.pos, t.pos) <= 2)).length;
		return tasks.length ? Math.round((done / tasks.length) * 100) : 0;
	}

	// ---------- judge controls ----------

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

	private stats(alive: Drone[], onShow: number, clashes: number): StatItem[] {
		const jammed = alive.filter((d) => d.jammed);
		// A jammed drone is "in sync" while it's lit and flying a show off the shared clock.
		const synced = jammed.filter((d) => d.color !== UNLIT).length;
		const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
		return [
			{
				label: "Flock alive",
				value: alive.length,
				unit: `/ ${DRONES}`,
				tone: "flock",
				hero: true,
				hint: alive.length < DRONES ? `${DRONES - alive.length} down: the rest re-flowed into the picture` : "Click a drone to take it down",
			},
			{
				label: "Got the new show",
				value: pct(onShow, alive.length),
				unit: "%",
				tone: "good",
				hero: true,
				hint: `${onShow} of ${alive.length} drones, passed drone to drone. No central link.`,
			},
			{
				label: "Packets lost",
				value: this.lossPct,
				unit: "%",
				tone: "bad",
				hero: true,
				hint: jammed.length ? `plus ${jammed.length} drone${jammed.length > 1 ? "s" : ""} inside a jammer` : "drag the loss slider up to stress it",
			},
			{
				label: "Jammed, still dancing",
				value: jammed.length ? pct(synced, jammed.length) : "–",
				unit: jammed.length ? "%" : undefined,
				tone: "warn",
				hero: true,
				hint: jammed.length ? `${synced} of ${jammed.length} jammed drones keep the beat on the shared clock` : "Drag on the sky to drop a jammer",
			},
			{
				label: "Mid-air clashes",
				value: clashes,
				tone: clashes ? "bad" : "good",
				hero: true,
				hint: "two drones claiming the same slot",
			},
			{ label: "Lights on", value: alive.filter((d) => d.color !== UNLIT).length },
			{ label: "Radio links", value: this.links.length },
			{ label: "Shows sent", value: this.current.seq + 1 },
			{ label: "Elapsed", value: Math.floor(this.tick / 10), unit: "s" },
			{ label: "Show", value: SHOWS[this.current.show].name },
		];
	}

	snapshot(): SkySnap {
		const alive = this.drones.filter((d) => d.alive);
		const claims = new Map<string, number>();
		for (const d of alive) {
			if (d.claim) {
				claims.set(d.claim, (claims.get(d.claim) ?? 0) + 1);
			}
		}
		const onShow = alive.filter((d) => d.mission.seq === this.current.seq).length;

		return {
			tick: this.tick,
			drones: this.drones.map((d) => ({
				id: d.id,
				pos: { ...d.pos },
				alive: d.alive,
				jammed: d.alive && d.jammed,
				color: d.color,
				fresh: d.heardAt > 0 && this.tick - d.heardAt < 10,
				stale: d.alive && d.mission.seq !== this.current.seq,
			})),
			links: this.links.map(([a, b]) => [{ ...a.pos }, { ...b.pos }]),
			jams: this.jams,
			targets: this.tasksFor(this.current, alive.length)
				.filter((t) => t.color !== UNLIT)
				.map((t) => ({ pos: t.pos, color: t.color! })),
			show: this.current.show,
			autoplay: this.autoplay,
			transmitting: this.tick - this.current.start < 30,
			headline: this.formed,
			history: [...this.history],
			chatter: this.chatter.slice(-8).reverse(),
			lossPct: this.lossPct,
			stats: this.stats(alive, onShow, [...claims.values()].filter((n) => n > 1).length),
		};
	}
}
