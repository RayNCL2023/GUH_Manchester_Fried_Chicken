// Ground station: a fixed antenna on a rooftop that only knows what the drones manage to radio down to it.
// A drone is in DIRECT contact when it is in range and the straight path between them is clear of jammers
// (a jammer anywhere on that path drowns the signal). Drones without a clear path can still be heard through
// the mesh: any chain of drone-to-drone links that ends at a direct drone carries their map and status down
// (RELAY). Drones nobody can hear are DARK. Everything the voice agent says comes from this picture.
import type { CellState, GoalBody, Vec } from "../../../../shared/types";
import type { Area } from "./osm";

export const ANTENNA_ID = "Ground";
// A rooftop sector antenna on a mast reaches well past the map edge; jamming, not range, is what bites.
export const ANTENNA_M = 1200;

export type LinkState = "direct" | "relay" | "dark";
export type FireCluster = { x: number; y: number; cells: number; lat: number; lon: number };
export type StationEvent = { n: number; tick: number; text: string; alert?: boolean };

type Jam = { center: Vec; radius: number };
type Drone = { id: string; pos: Vec; alive: boolean };

const M_PER_DEG = 111320;
const SETTLE_TICKS = 12; // a link state must hold this long before it's worth an event
const MAX_EVENTS = 60;

export function cellToLatLon(area: Area & { width: number; height: number }, x: number, y: number) {
	const e = (x - area.width / 2) * area.mPerCell;
	const n = (area.height / 2 - y) * area.mPerCell;
	return {
		lat: area.lat + n / M_PER_DEG,
		lon: area.lon + e / (M_PER_DEG * Math.cos((area.lat * Math.PI) / 180)),
	};
}

export function latLonToCell(area: Area & { width: number; height: number }, lat: number, lon: number) {
	const e = (lon - area.lon) * M_PER_DEG * Math.cos((area.lat * Math.PI) / 180);
	const n = (lat - area.lat) * M_PER_DEG;
	return { x: e / area.mPerCell + area.width / 2, y: area.height / 2 - n / area.mPerCell };
}

// Does the segment a→b pass within r of c?
function segmentHits(a: Vec, b: Vec, c: Vec, r: number) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2)) : 0;
	return Math.hypot(a.x + dx * t - c.x, a.y + dy * t - c.y) <= r;
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

export class GroundStation {
	link = new Map<string, LinkState>();
	lastHeard = new Map<string, number>();
	heard = 0;
	blocked = 0;
	jammed = false;
	fireCells = 0;
	clusters: FireCluster[] = [];
	events: StationEvent[] = [];
	lastUplink: { tick: number; via: string; goal: GoalBody } | null = null;
	private pending = new Map<string, { state: LinkState; since: number }>();
	private reported = new Map<string, LinkState>();
	private seq = 0;
	private evN = 0;

	constructor(
		readonly area: Area & { width: number; height: number },
		readonly name: string,
		readonly pos: Vec,
		readonly rangeCells: number,
	) {}

	reset() {
		this.link.clear();
		this.lastHeard.clear();
		this.pending.clear();
		this.reported.clear();
		this.heard = 0;
		this.blocked = 0;
		this.jammed = false;
		this.fireCells = 0;
		this.clusters = [];
		this.events = [];
		this.lastUplink = null;
	}

	event(tick: number, text: string, alert = false) {
		this.events.push({ n: ++this.evN, tick, text, alert });
		if (this.events.length > MAX_EVENTS) {
			this.events.shift();
		}
	}

	// Direct path: in range, neither end inside a jammer, and no jammer sitting on the line between them.
	pathTo(p: Vec, jams: Jam[]): "ok" | "range" | "jammed" {
		if (Math.hypot(p.x - this.pos.x, p.y - this.pos.y) > this.rangeCells) {
			return "range";
		}
		return jams.some((z) => segmentHits(this.pos, p, z.center, z.radius)) ? "jammed" : "ok";
	}

	// Recompute who the station can hear after a sim tick. links = live drone-to-drone links.
	update(tick: number, drones: Drone[], links: [string, string][], jams: Jam[]) {
		const wasJammed = this.jammed;
		this.jammed = jams.some((z) => Math.hypot(z.center.x - this.pos.x, z.center.y - this.pos.y) <= z.radius);
		if (this.jammed !== wasJammed) {
			this.event(tick, this.jammed ? "Antenna is jammed: no direct link to any drone" : "Antenna jamming cleared", true);
		}

		const next = new Map<string, LinkState>();
		const queue: string[] = [];
		for (const d of drones) {
			if (!d.alive) {
				continue;
			}
			const direct = !this.jammed && this.pathTo(d.pos, jams) === "ok";
			next.set(d.id, direct ? "direct" : "dark");
			if (direct) {
				queue.push(d.id);
			}
		}
		// Mesh relay: flood out from every direct drone over drone-to-drone links.
		const adj = new Map<string, string[]>();
		for (const [a, b] of links) {
			adj.set(a, [...(adj.get(a) ?? []), b]);
			adj.set(b, [...(adj.get(b) ?? []), a]);
		}
		while (queue.length) {
			const id = queue.shift()!;
			for (const n of adj.get(id) ?? []) {
				if (next.get(n) === "dark") {
					next.set(n, "relay");
					queue.push(n);
				}
			}
		}
		// The station can't tell a dead drone from a silent one: both just go dark.
		for (const d of drones) {
			if (!d.alive) {
				next.set(d.id, "dark");
			}
			const s = next.get(d.id)!;
			if (s !== "dark") {
				this.lastHeard.set(d.id, tick);
			}
		}
		this.link = next;
		this.settle(tick);
	}

	// Report link changes only once they've held for a moment, so a drone skimming a jammer's edge doesn't spam.
	// Changes that land together are rolled into one line; while the antenna itself is jammed they're implied.
	private settle(tick: number) {
		const lost: string[] = [];
		const back: string[] = [];
		const relayed: string[] = [];
		for (const [id, state] of this.link) {
			const p = this.pending.get(id);
			if (!p || p.state !== state) {
				this.pending.set(id, { state, since: tick });
				continue;
			}
			const was = this.reported.get(id);
			if (tick - p.since < SETTLE_TICKS || was === state) {
				continue;
			}
			this.reported.set(id, state);
			if (was === undefined) {
				continue;
			}
			if (state === "dark") {
				lost.push(id);
			} else if (was === "dark") {
				back.push(id);
			} else if (state === "relay") {
				relayed.push(id);
			}
		}
		const list = (ids: string[]) => (ids.length <= 3 ? ids.join(", ") : `${ids.slice(0, 2).join(", ")} and ${ids.length - 2} more`);
		if (lost.length && !this.jammed) {
			this.event(tick, `Lost contact with ${list(lost)}`, true);
		}
		if (back.length) {
			this.event(tick, `Regained contact with ${list(back)}`);
		}
		if (relayed.length) {
			this.event(tick, `${list(relayed)}: direct path jammed, still reporting through the mesh relay`);
		}
	}

	hearChatter(tick: number, from: string, line: string) {
		if (this.link.get(from) === "dark") {
			return;
		}
		this.event(tick, `${from}: "${line}"`);
	}

	countPacket(ok: boolean) {
		if (ok) {
			this.heard++;
		} else {
			this.blocked++;
		}
	}

	// The fire as the station knows it: every cell some drone it can hear (directly or relayed) believes is burning.
	updateFire(tick: number, maps: { id: string; map: { get(x: number, y: number): CellState } }[]) {
		const { width, height } = this.area;
		const heard = maps.filter((m) => this.link.get(m.id) && this.link.get(m.id) !== "dark");
		const fire = new Uint8Array(width * height);
		let n = 0;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (heard.some((m) => m.map.get(x, y) === "fire")) {
					fire[y * width + x] = 1;
					n++;
				}
			}
		}
		const before = this.clusters;
		this.fireCells = n;
		this.clusters = this.cluster(fire);
		for (const c of this.clusters) {
			const known = before.some((b) => Math.hypot(b.x - c.x, b.y - c.y) < 12);
			if (!known && c.cells >= 4) {
				this.event(tick, `New fire reported ${this.describe(c.x, c.y)} (${c.cells} cells burning)`, true);
			}
		}
		for (const b of before) {
			if (b.cells >= 4 && !this.clusters.some((c) => Math.hypot(b.x - c.x, b.y - c.y) < 12)) {
				this.event(tick, `Fire ${this.describe(b.x, b.y)} is out`, true);
			}
		}
	}

	// Connected fire regions (8-neighbour, bridging 2-cell gaps), largest first.
	private cluster(fire: Uint8Array): FireCluster[] {
		const { width, height } = this.area;
		const seen = new Uint8Array(fire.length);
		const out: FireCluster[] = [];
		for (let i = 0; i < fire.length; i++) {
			if (!fire[i] || seen[i]) {
				continue;
			}
			let sx = 0;
			let sy = 0;
			let n = 0;
			const stack = [i];
			seen[i] = 1;
			while (stack.length) {
				const j = stack.pop()!;
				const x = j % width;
				const y = Math.floor(j / width);
				sx += x;
				sy += y;
				n++;
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) {
						const nx = x + dx;
						const ny = y + dy;
						const k = ny * width + nx;
						if (nx < 0 || ny < 0 || nx >= width || ny >= height || !fire[k] || seen[k]) {
							continue;
						}
						seen[k] = 1;
						stack.push(k);
					}
				}
			}
			const cx = sx / n;
			const cy = sy / n;
			out.push({ x: cx, y: cy, cells: n, ...cellToLatLon(this.area, cx, cy) });
		}
		return out.sort((a, b) => b.cells - a.cells);
	}

	// "340 m north-east of the antenna"
	describe(x: number, y: number) {
		const dx = x - this.pos.x;
		const dy = y - this.pos.y;
		const m = Math.round((Math.hypot(dx, dy) * this.area.mPerCell) / 10) * 10;
		if (m < 30) {
			return `right at the antenna (${this.name})`;
		}
		const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
		const dir = COMPASS[Math.round(((deg + 360) % 360) / 45) % 8];
		return `${m} m ${dir} of the antenna`;
	}

	nextGoalId() {
		return `ground-${++this.seq}`;
	}
}
