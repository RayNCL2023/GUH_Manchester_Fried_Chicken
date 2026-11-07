// Virtual traffic on the real OSM road graph: UK keep-left, one-ways, simple car following,
// cars turn back from fire, and fire engines are routed to the blaze with beacons flashing.
import { Group, MeshBasicMaterial, type Object3D, type Scene } from "three";
import type { Frame, Heightmap } from "./geo";
import type { FireFX } from "./fire";
import { makeCar, makeFireEngine, type FireEngine } from "./models";

const SPEED: Record<string, number> = {
	motorway: 26,
	trunk: 18,
	primary: 13,
	secondary: 13,
	tertiary: 11,
	unclassified: 9,
	residential: 8,
	living_street: 4,
	service: 5,
};
const LANE = 1.7; // metres left of the centreline (UK)
const GAP = 9; // following distance
const LOOK_AHEAD = 18; // turn back if fire is this close ahead
const ENGINES = 2;

type Node = { e: number; n: number; out: number[] };
type Edge = { a: number; b: number; len: number; de: number; dn: number; speed: number; twoWay: boolean };

type Car = {
	obj: Object3D;
	edge: number;
	s: number;
	v: number;
	y: number;
	engine?: FireEngine;
	route?: number[]; // edges left to drive (fire engines)
	parked?: boolean;
};

function oneway(tags: Record<string, string>) {
	const o = tags.oneway;
	if (o === "-1") {
		return -1;
	}
	if (o === "yes" || o === "true" || o === "1" || tags.junction === "roundabout" || tags.highway === "motorway") {
		return 1;
	}
	return 0;
}

export class Traffic {
	readonly group = new Group();
	private nodes: Node[] = [];
	private edges: Edge[] = [];
	private cars: Car[] = [];
	private enabled = true;
	private fireSeen = 0;
	private dispatched = false;
	private t = 0;

	constructor(
		private frame: Frame,
		private heights: Heightmap,
		private fire: FireFX,
	) {
		this.build();
		const total = this.edges.reduce((s, e) => s + e.len, 0);
		const count = Math.min(70, Math.round(total / 120));
		for (let i = 0; i < count; i++) {
			this.addCar();
		}
	}

	addTo(scene: Scene) {
		scene.add(this.group);
	}

	get count() {
		return this.cars.length;
	}

	private build() {
		const index = new Map<string, number>();
		const node = (lat: number, lon: number) => {
			const key = `${lat},${lon}`;
			let id = index.get(key);
			if (id === undefined) {
				const { e, n } = this.frame.latLonEN(lat, lon);
				id = this.nodes.push({ e, n, out: [] }) - 1;
				index.set(key, id);
			}
			return id;
		};
		const link = (a: number, b: number, speed: number, twoWay: boolean) => {
			const A = this.nodes[a];
			const B = this.nodes[b];
			const len = Math.hypot(B.e - A.e, B.n - A.n);
			if (len < 0.5) {
				return;
			}
			const id = this.edges.push({ a, b, len, de: (B.e - A.e) / len, dn: (B.n - A.n) / len, speed, twoWay }) - 1;
			A.out.push(id);
		};

		for (const el of this.frame.area.osm.elements) {
			const tags = el.tags ?? {};
			const kind = tags.highway?.replace("_link", "");
			if (!kind || !(kind in SPEED) || !el.geometry) {
				continue;
			}
			const dir = oneway(tags);
			const pts = el.geometry;
			for (let i = 0; i + 1 < pts.length; i++) {
				const a = node(pts[i].lat, pts[i].lon);
				const b = node(pts[i + 1].lat, pts[i + 1].lon);
				const pa = this.nodes[a];
				const pb = this.nodes[b];
				// Keep the network inside the mapped area.
				if (!this.frame.inBounds(pa.e, pa.n, 4) || !this.frame.inBounds(pb.e, pb.n, 4)) {
					continue;
				}
				const speed = SPEED[kind] * (0.85 + Math.random() * 0.3);
				if (dir >= 0) {
					link(a, b, speed, dir === 0);
				}
				if (dir <= 0) {
					link(b, a, speed, dir === 0);
				}
			}
		}
	}

	private randomEdge() {
		// Weight by length so cars spread along the network, not clump on short stubs.
		const total = this.edges.reduce((s, e) => s + e.len, 0);
		let r = Math.random() * total;
		for (let i = 0; i < this.edges.length; i++) {
			r -= this.edges[i].len;
			if (r <= 0) {
				return i;
			}
		}
		return 0;
	}

	private addCar(engine?: FireEngine, edge = this.randomEdge()) {
		if (!this.edges.length) {
			return null;
		}
		const obj = engine ? engine.object : makeCar();
		const car: Car = { obj, edge, s: Math.random() * this.edges[edge].len, v: 0, y: NaN, engine };
		this.cars.push(car);
		this.group.add(obj);
		return car;
	}

	private reverse(edgeId: number) {
		const e = this.edges[edgeId];
		return this.nodes[e.b].out.find((id) => this.edges[id].b === e.a) ?? -1;
	}

	// Pick the next edge at a junction: mostly straight on, never straight back unless it's a dead end.
	private next(edgeId: number) {
		const e = this.edges[edgeId];
		const options = this.nodes[e.b].out.filter((id) => this.edges[id].b !== e.a);
		if (!options.length) {
			return this.reverse(edgeId);
		}
		const weights = options.map((id) => {
			const o = this.edges[id];
			return 0.4 + Math.max(0, o.de * e.de + o.dn * e.dn) * 2;
		});
		let r = Math.random() * weights.reduce((s, w) => s + w, 0);
		for (let i = 0; i < options.length; i++) {
			r -= weights[i];
			if (r <= 0) {
				return options[i];
			}
		}
		return options[0];
	}

	// Dijkstra over edges to the node closest to (e, n).
	private routeTo(fromEdge: number, e: number, n: number) {
		let goal = -1;
		let best = Infinity;
		this.nodes.forEach((nd, i) => {
			const d = Math.hypot(nd.e - e, nd.n - n);
			const cell = this.frame.cellOf(this.frame.world(nd.e, nd.n, 0));
			// Stop short of the flames, not in them.
			if (d < best && d > 25 && !this.fire.isBurning(cell.x, cell.y) && nd.out.length) {
				best = d;
				goal = i;
			}
		});
		if (goal < 0) {
			return null;
		}
		const start = this.edges[fromEdge].b;
		const dist = new Map<number, number>([[start, 0]]);
		const via = new Map<number, number>();
		const open = new Set([start]);
		while (open.size) {
			let cur = -1;
			let cd = Infinity;
			for (const id of open) {
				const d = dist.get(id)!;
				if (d < cd) {
					cd = d;
					cur = id;
				}
			}
			open.delete(cur);
			if (cur === goal) {
				break;
			}
			for (const eid of this.nodes[cur].out) {
				const ed = this.edges[eid];
				const nd = cd + ed.len;
				if (nd < (dist.get(ed.b) ?? Infinity)) {
					dist.set(ed.b, nd);
					via.set(ed.b, eid);
					open.add(ed.b);
				}
			}
		}
		if (!via.has(goal)) {
			return null;
		}
		const path: number[] = [];
		for (let at = goal; at !== start; at = this.edges[via.get(at)!].a) {
			path.unshift(via.get(at)!);
		}
		return path;
	}

	setEnabled(on: boolean) {
		this.enabled = on;
		this.group.visible = on;
	}

	private dispatch() {
		const c = this.fire.centroid();
		if (!c) {
			return;
		}
		const target = { e: -c.x, n: c.z };
		const engines = this.cars.filter((k) => k.engine);
		// Crews already out on the roads from the last fire get re-tasked first.
		for (const k of engines) {
			k.parked = false;
			k.route = this.routeTo(k.edge, target.e, target.n) ?? undefined;
		}
		for (let i = engines.length; i < ENGINES; i++) {
			// Enter from a far edge of the map, like crews arriving from the station.
			let edge = this.randomEdge();
			for (let tries = 0; tries < 20; tries++) {
				const cand = this.randomEdge();
				const nd = this.nodes[this.edges[cand].a];
				if (Math.hypot(nd.e - target.e, nd.n - target.n) > Math.hypot(this.nodes[this.edges[edge].a].e - target.e, this.nodes[this.edges[edge].a].n - target.n)) {
					edge = cand;
				}
			}
			const car = this.addCar(makeFireEngine(), edge);
			if (car) {
				car.s = 0;
				car.route = this.routeTo(edge, target.e, target.n) ?? undefined;
			}
		}
	}

	private releaseEngines() {
		for (const c of this.cars) {
			if (c.engine) {
				c.route = undefined;
				c.parked = false;
			}
		}
	}

	update(dt: number) {
		if (!this.enabled || !this.edges.length) {
			return;
		}
		this.t += dt;

		// Fire engines roll once a fire has been burning a few seconds, and go home after it's out.
		if (this.fire.fireCount > 0) {
			this.fireSeen += dt;
			if (this.fireSeen > 3 && !this.dispatched) {
				this.dispatched = true;
				this.dispatch();
			}
		} else if (this.fireSeen > 0) {
			this.fireSeen = 0;
			this.dispatched = false;
			this.releaseEngines();
		}

		// Cars on each edge, front to back, for following distance.
		const byEdge = new Map<number, Car[]>();
		for (const c of this.cars) {
			const list = byEdge.get(c.edge) ?? [];
			list.push(c);
			byEdge.set(c.edge, list);
		}
		for (const list of byEdge.values()) {
			list.sort((p, q) => q.s - p.s);
		}

		for (const c of this.cars) {
			const e = this.edges[c.edge];
			let target = c.parked ? 0 : e.speed * (c.engine && c.route ? 1.25 : 1);

			const list = byEdge.get(c.edge)!;
			const ahead = list[list.indexOf(c) - 1];
			if (ahead && ahead.s - c.s < GAP + 6) {
				target = Math.min(target, Math.max(0, (ahead.s - c.s - GAP) * 0.8));
			}

			// Fire across the road ahead: civilians turn round, engines stop and work.
			const look = Math.min(e.len, c.s + LOOK_AHEAD);
			const ahead2 = this.frame.cellOf(this.frame.world(this.nodes[e.a].e + e.de * look, this.nodes[e.a].n + e.dn * look, 0));
			if (this.fire.isBurning(ahead2.x, ahead2.y)) {
				if (c.engine) {
					c.parked = true;
				} else {
					const rev = this.reverse(c.edge);
					if (rev >= 0) {
						c.edge = rev;
						c.s = Math.max(0, e.len - c.s);
						c.v *= 0.3;
						continue;
					}
					target = 0;
				}
			}

			c.v += Math.max(-8 * dt, Math.min(3 * dt, target - c.v));
			c.s += c.v * dt;

			while (c.s >= this.edges[c.edge].len) {
				c.s -= this.edges[c.edge].len;
				if (c.route) {
					const nx = c.route.shift();
					if (nx === undefined) {
						c.parked = true;
						c.s = this.edges[c.edge].len;
						break;
					}
					c.edge = nx;
				} else {
					const nx = this.next(c.edge);
					c.edge = nx >= 0 ? nx : this.randomEdge();
				}
			}
			this.place(c, dt);
		}

		// Beacons alternate.
		const on = Math.floor(this.t * 6) % 2 === 0;
		for (const c of this.cars) {
			c.engine?.beacons.forEach((b, i) => {
				(b.material as MeshBasicMaterial).color.setHex((i % 2 === 0) === on ? 0x3d7bff : 0x0a1a40);
			});
		}
	}

	private place(c: Car, dt: number) {
		const e = this.edges[c.edge];
		const a = this.nodes[e.a];
		const s = Math.min(c.s, e.len);
		const lane = e.twoWay ? LANE * (c.engine ? 1.2 : 1) : 0;
		// Left of travel in east/north is (-dn, de).
		const pe = a.e + e.de * s - e.dn * lane;
		const pn = a.n + e.dn * s + e.de * lane;
		const cell = this.frame.cellOf(this.frame.world(pe, pn, 0));
		const ground = this.heights.minNear(cell.x, cell.y, 1);
		c.y = Number.isNaN(c.y) ? ground : c.y + (ground - c.y) * Math.min(1, dt * 3);
		this.frame.world(pe, pn, c.y, c.obj.position);
		// World heading of (de, dn) is (-de, dn); objects face +Z.
		const yaw = Math.atan2(-e.de, e.dn);
		let d = yaw - c.obj.rotation.y;
		d = Math.atan2(Math.sin(d), Math.cos(d));
		c.obj.rotation.y += d * Math.min(1, dt * 8);
	}

	dispose() {
		this.group.clear();
		this.cars = [];
	}
}
