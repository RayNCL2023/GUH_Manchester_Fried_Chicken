// The flock in 3D: sim positions smoothed between 10 Hz ticks, flown at a safe height over the
// real terrain/buildings, with radio links, jam zones and the selected drone's sensor footprint.
import {
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	Color,
	ConeGeometry,
	CylinderGeometry,
	DynamicDrawUsage,
	Group,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	Sprite,
	SpriteMaterial,
	SphereGeometry,
	Vector3,
	type Object3D,
	type Scene,
} from "three";
import type { WorldView } from "../../../../../shared/types";
import { C, MODE_COLOR, agentState } from "../pixel";
import type { Frame, Heightmap } from "./geo";
import { makeDrone, type Drone } from "./models";

const CLEARANCE = 32; // metres above the tallest thing nearby
const TICK_S = 0.1;
const MAX_LINKS = 400;

type Unit = {
	id: string;
	drone: Drone;
	beacon: Sprite;
	hit: Mesh;
	from: Vector3; // EN + alt at last tick
	to: Vector3;
	t: number; // seconds since last tick
	pos: Vector3; // current world position
	yaw: number;
	alive: boolean;
	fallV: number;
	state: string;
};

function dotTexture() {
	const c = document.createElement("canvas");
	c.width = c.height = 64;
	const ctx = c.getContext("2d")!;
	ctx.fillStyle = "#fff";
	ctx.beginPath();
	ctx.arc(32, 32, 22, 0, Math.PI * 2);
	ctx.fill();
	ctx.lineWidth = 6;
	ctx.strokeStyle = "rgba(15,15,17,0.9)";
	ctx.stroke();
	return new CanvasTexture(c);
}

export class DroneFX {
	readonly group = new Group();
	private units = new Map<string, Unit>();
	private links: LineSegments;
	private linkPos = new Float32Array(MAX_LINKS * 6);
	private linkPairs: [string, string][] = [];
	private jams = new Group();
	private jamKey = "";
	private cone: Mesh;
	private dot = dotTexture();
	private hitGeo = new SphereGeometry(7, 8, 6);
	private hitMat = new MeshBasicMaterial({ visible: false });
	selected: string | null = null;

	constructor(
		private frame: Frame,
		private heights: Heightmap,
		private sensorCells: number,
	) {
		const geo = new BufferGeometry();
		geo.setAttribute("position", new BufferAttribute(this.linkPos, 3).setUsage(DynamicDrawUsage));
		geo.setDrawRange(0, 0);
		this.links = new LineSegments(geo, new LineBasicMaterial({ color: C.flock, transparent: true, opacity: 0.55, depthWrite: false }));
		this.links.frustumCulled = false;

		// Unit cone, apex at the drone, base on the ground. Scaled per frame.
		const cone = new ConeGeometry(1, 1, 40, 1, true).translate(0, -0.5, 0);
		this.cone = new Mesh(cone, new MeshBasicMaterial({ color: C.flock, transparent: true, opacity: 0.12, depthWrite: false }));
		this.cone.visible = false;

		this.group.add(this.links, this.jams, this.cone);
	}

	addTo(scene: Scene) {
		scene.add(this.group);
	}

	// Things a click can hit.
	pickables(): Object3D[] {
		return [...this.units.values()].filter((u) => u.alive).map((u) => u.hit);
	}

	idOf(o: Object3D) {
		return (o.userData.droneId as string) ?? null;
	}

	position(id: string) {
		return this.units.get(id)?.pos ?? null;
	}

	heading(id: string) {
		return this.units.get(id)?.yaw ?? 0;
	}

	private cruise(x: number, y: number, k: number) {
		// Fly above the tallest thing around, staggered so drones don't sit on top of each other.
		return this.heights.maxNear(x, y, 3) + CLEARANCE + (k % 3) * 5;
	}

	setView(view: WorldView) {
		const seen = new Set<string>();
		view.agents.forEach((a, k) => {
			seen.add(a.id);
			const cx = a.pos.x + 0.5;
			const cy = a.pos.y + 0.5;
			const { e, n } = this.frame.cellEN(cx, cy);
			let u = this.units.get(a.id);
			if (!u) {
				u = this.spawnUnit(a.id, new Vector3(e, this.cruise(cx, cy, k), n));
			}
			u.from.set(...this.enAlt(u));
			u.to.set(e, a.alive ? this.cruise(cx, cy, k) : u.to.y, n);
			u.t = 0;
			u.state = agentState(a);
			if (u.alive && !a.alive) {
				u.fallV = 0;
			}
			u.alive = a.alive;
			const colour = new Color(MODE_COLOR[u.state] ?? C.flock);
			u.drone.led.color.copy(colour);
			(u.beacon.material as SpriteMaterial).color.copy(colour);
		});
		for (const [id, u] of this.units) {
			if (!seen.has(id)) {
				this.group.remove(u.drone.object, u.beacon, u.hit);
				this.units.delete(id);
			}
		}
		this.linkPairs = view.links;
		this.setJams(view.jamZones);
	}

	// Current position back in EN + altitude terms, so the next tick blends from where we are.
	private enAlt(u: Unit): [number, number, number] {
		return [-u.pos.x, u.pos.y, u.pos.z];
	}

	private spawnUnit(id: string, en: Vector3) {
		const drone = makeDrone(C.flock);
		const beacon = new Sprite(new SpriteMaterial({ map: this.dot, color: C.flock, depthTest: false, sizeAttenuation: false }));
		beacon.scale.setScalar(0.014);
		beacon.renderOrder = 10;
		const hit = new Mesh(this.hitGeo, this.hitMat);
		hit.userData.droneId = id;
		const pos = this.frame.world(en.x, en.z, en.y); // en is (east, alt, north)
		const u: Unit = { id, drone, beacon, hit, from: en.clone(), to: en.clone(), t: 1, pos, yaw: 0, alive: true, fallV: 0, state: "normal" };
		drone.object.position.copy(pos);
		this.group.add(drone.object, beacon, hit);
		this.units.set(id, u);
		return u;
	}

	private setJams(zones: WorldView["jamZones"]) {
		const key = JSON.stringify(zones);
		if (key === this.jamKey) {
			return;
		}
		this.jamKey = key;
		this.jams.clear();
		for (const z of zones) {
			const r = z.radius * this.frame.m;
			const { e, n } = this.frame.cellEN(z.center.x, z.center.y);
			const ground = this.heights.at(z.center.x, z.center.y);
			const cyl = new Mesh(
				new CylinderGeometry(r, r, 160, 48, 1, true),
				new MeshBasicMaterial({ color: C.ember, transparent: true, opacity: 0.1, depthWrite: false }),
			);
			this.frame.world(e, n, ground + 80, cyl.position);
			this.jams.add(cyl);
		}
	}

	update(dt: number, now: number) {
		for (const u of this.units.values()) {
			u.t += dt;
			const k = Math.min(1, u.t / TICK_S);
			const e = u.from.x + (u.to.x - u.from.x) * k;
			const n = u.from.z + (u.to.z - u.from.z) * k;
			let alt = u.from.y + (u.to.y - u.from.y) * Math.min(1, k * 0.35);

			if (!u.alive) {
				const c = this.frame.cellOf(u.pos);
				const floor = this.heights.at(c.x, c.y) + 0.6;
				u.fallV += 9.8 * dt;
				alt = Math.max(floor, u.pos.y - u.fallV * dt);
				u.to.y = alt;
			}
			const prevX = u.pos.x;
			const prevZ = u.pos.z;
			this.frame.world(e, n, alt, u.pos);

			const vx = (u.pos.x - prevX) / Math.max(dt, 1e-3);
			const vz = (u.pos.z - prevZ) / Math.max(dt, 1e-3);
			const speed = Math.hypot(vx, vz);
			if (speed > 0.5 && u.alive) {
				const target = Math.atan2(vx, vz);
				let d = target - u.yaw;
				d = Math.atan2(Math.sin(d), Math.cos(d));
				u.yaw += d * Math.min(1, dt * 4);
			}

			const o = u.drone.object;
			o.position.copy(u.pos);
			o.rotation.set(0, u.yaw, 0);
			// Nose dips with speed, like a real multirotor.
			o.rotateX(Math.min(0.35, speed * 0.02));
			if (!u.alive) {
				o.rotation.z = 0.6;
			}
			const flash = u.state === "jammed" ? Math.sin(now * 12) > 0 : true;
			u.drone.led.visible = flash;
			for (const r of u.drone.rotors) {
				r.rotation.y += u.alive ? dt * 60 : 0;
			}
			u.beacon.position.copy(u.pos).setY(u.pos.y + 3);
			u.beacon.visible = u.alive;
			u.hit.position.copy(u.pos);
		}
		this.updateLinks();
		this.updateCone();
	}

	private updateLinks() {
		let k = 0;
		for (const [a, b] of this.linkPairs) {
			const pa = this.units.get(a)?.pos;
			const pb = this.units.get(b)?.pos;
			if (!pa || !pb || k >= MAX_LINKS) {
				continue;
			}
			this.linkPos.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], k * 6);
			k++;
		}
		const geo = this.links.geometry;
		geo.setDrawRange(0, k * 2);
		geo.attributes.position.needsUpdate = true;
	}

	private updateCone() {
		const u = this.selected ? this.units.get(this.selected) : null;
		if (!u || !u.alive) {
			this.cone.visible = false;
			return;
		}
		const c = this.frame.cellOf(u.pos);
		const ground = this.heights.at(c.x, c.y);
		const h = Math.max(1, u.pos.y - ground);
		const r = this.sensorCells * this.frame.m;
		this.cone.visible = true;
		this.cone.position.copy(u.pos);
		this.cone.scale.set(r, h, r);
	}

	dispose() {
		this.dot.dispose();
		this.hitGeo.dispose();
		this.links.geometry.dispose();
		this.cone.geometry.dispose();
	}
}
