// The fleet in 3D: sim positions smoothed between 10 Hz ticks and flown over the real terrain/buildings.
// Echo quads at low patrol height, Sky fixed-wings loitering high above, Water heavy-lifts low over the fire.
// Every drone carries a name tag; the selected one shows its camera pyramid; jammers show their dome.
import {
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	Color,
	DoubleSide,
	DynamicDrawUsage,
	Group,
	LineBasicMaterial,
	LineDashedMaterial,
	LineLoop,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	SphereGeometry,
	Sprite,
	SpriteMaterial,
	Vector3,
	type Object3D,
	type Scene,
} from "three";
import type { WorldView } from "../../../../../shared/types";
import { C, MODE_COLOR, agentState } from "../pixel";
import { ALTITUDE_M, type Role, type UnitInfo } from "../roles";
import type { Frame, Heightmap } from "./geo";
import { makeDrone, type Drone } from "./models";
import { WaterFX } from "./water";
import { RadioFX } from "./radio";
import type { RadioBeam } from "../fireLive";

const TICK_S = 0.1;
// Rendered by the overview camera only. Droplets right under a drone's own lens become screen-sized
// sprites and tank the frame rate.
export const OVERVIEW_LAYER = 1;
const MAX_LINKS = 400;
const LOITER_M = 70; // fixed-wing orbit radius while holding station
const LOITER_MS = 28; // airspeed round that orbit
const ROLE_COLOUR: Record<Role, string> = { echo: C.flock, sky: C.glow, water: C.water };

type Unit = {
	id: string;
	role: Role;
	drone: Drone;
	beacon: Sprite;
	label: Label;
	hit: Mesh;
	from: Vector3; // EN + alt at last tick
	to: Vector3;
	t: number; // seconds since last tick
	centre: Vector3; // sim position in world space (what the camera is centred on)
	pos: Vector3; // where the airframe is (fixed-wings orbit the centre)
	loiter: number; // current orbit radius
	orbit: number; // orbit phase
	yaw: number;
	bank: number;
	alive: boolean;
	fallV: number;
	state: string;
	info: UnitInfo;
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

// Screen-space name tag: a dark pill with the drone's name in its role colour. Redrawn only on change.
class Label {
	readonly sprite: Sprite;
	private canvas = document.createElement("canvas");
	private tex: CanvasTexture;
	private text = "";
	private colour = "";

	constructor(private height = 0.024) {
		this.canvas.width = 512;
		this.canvas.height = 96;
		this.tex = new CanvasTexture(this.canvas);
		this.sprite = new Sprite(new SpriteMaterial({ map: this.tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
		this.sprite.center.set(0.5, 0);
		this.sprite.scale.set(this.height * (512 / 96), this.height, 1);
		this.sprite.renderOrder = 11;
	}

	set(text: string, colour: string) {
		if (text === this.text && colour === this.colour) {
			return;
		}
		this.text = text;
		this.colour = colour;
		const ctx = this.canvas.getContext("2d")!;
		ctx.clearRect(0, 0, 512, 96);
		ctx.font = "600 44px ui-sans-serif, system-ui, sans-serif";
		const w = Math.min(500, ctx.measureText(text).width + 44);
		const x = (512 - w) / 2;
		ctx.fillStyle = "rgba(15,15,17,0.82)";
		ctx.beginPath();
		ctx.roundRect(x, 14, w, 68, 34);
		ctx.fill();
		ctx.lineWidth = 3;
		ctx.strokeStyle = colour;
		ctx.stroke();
		ctx.fillStyle = colour;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(text, 256, 50);
		this.tex.needsUpdate = true;
	}

	dispose() {
		this.tex.dispose();
		(this.sprite.material as SpriteMaterial).dispose();
	}
}

// Unit pyramid: apex at the origin, square base (±1, -1, ±1). Scaled to the footprint each frame.
function pyramid() {
	const apex = [0, 0, 0];
	const b = [
		[-1, -1, -1],
		[1, -1, -1],
		[1, -1, 1],
		[-1, -1, 1],
	];
	const faces: number[] = [];
	for (let k = 0; k < 4; k++) {
		faces.push(...apex, ...b[k], ...b[(k + 1) % 4]);
	}
	const faceGeo = new BufferGeometry();
	faceGeo.setAttribute("position", new BufferAttribute(new Float32Array(faces), 3));
	const edges: number[] = [];
	for (let k = 0; k < 4; k++) {
		edges.push(...apex, ...b[k]);
		edges.push(...b[k], ...b[(k + 1) % 4]);
	}
	const edgeGeo = new BufferGeometry();
	edgeGeo.setAttribute("position", new BufferAttribute(new Float32Array(edges), 3));
	return { faceGeo, edgeGeo };
}

function circle(segments = 96) {
	const pts: number[] = [];
	for (let k = 0; k < segments; k++) {
		const a = (k / segments) * Math.PI * 2;
		pts.push(Math.cos(a), 0, Math.sin(a));
	}
	const g = new BufferGeometry();
	g.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
	return g;
}

type Jam = { group: Group; centre: { x: number; y: number }; label: Label };

export class DroneFX {
	readonly group = new Group();
	private units = new Map<string, Unit>();
	private links: LineSegments;
	private hot: LineSegments; // the selected drone's own links
	private linkPos = new Float32Array(MAX_LINKS * 6);
	private hotPos = new Float32Array(MAX_LINKS * 6);
	private linkPairs: [string, string][] = [];
	private jams: Jam[] = [];
	private jamKey = "";
	private fov = new Group();
	private fovFaces: Mesh;
	private fovEdges: LineSegments;
	private fovFoot: LineLoop;
	private dot = dotTexture();
	private hitGeo = new SphereGeometry(8, 8, 6);
	private hitMat = new MeshBasicMaterial({ visible: false });
	private domeGeo = new SphereGeometry(1, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2);
	private ringGeo = circle();
	private water: WaterFX;
	private radio = new RadioFX();
	selected: string | null = null;

	constructor(
		private frame: Frame,
		private heights: Heightmap,
	) {
		const geo = new BufferGeometry();
		geo.setAttribute("position", new BufferAttribute(this.linkPos, 3).setUsage(DynamicDrawUsage));
		geo.setDrawRange(0, 0);
		this.links = new LineSegments(geo, new LineBasicMaterial({ color: C.flock, transparent: true, opacity: 0.22, depthWrite: false }));
		this.links.frustumCulled = false;
		const hotGeo = new BufferGeometry();
		hotGeo.setAttribute("position", new BufferAttribute(this.hotPos, 3).setUsage(DynamicDrawUsage));
		hotGeo.setDrawRange(0, 0);
		this.hot = new LineSegments(hotGeo, new LineBasicMaterial({ color: C.text, transparent: true, opacity: 0.85, depthWrite: false }));
		this.hot.frustumCulled = false;

		const { faceGeo, edgeGeo } = pyramid();
		this.fovFaces = new Mesh(
			faceGeo,
			new MeshBasicMaterial({ color: C.flock, transparent: true, opacity: 0.14, side: DoubleSide, depthWrite: false }),
		);
		this.fovEdges = new LineSegments(edgeGeo, new LineDashedMaterial({ color: C.flock, dashSize: 0.06, gapSize: 0.04, depthWrite: false }));
		this.fovEdges.computeLineDistances();
		// Solid outline of what the camera sees on the ground.
		const foot = new BufferGeometry();
		foot.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1]), 3));
		this.fovFoot = new LineLoop(foot, new LineBasicMaterial({ color: C.flock, depthWrite: false }));
		this.fov.add(this.fovFaces, this.fovEdges, this.fovFoot);
		this.fov.visible = false;
		this.fov.renderOrder = 5;

		this.water = new WaterFX();
		this.water.object.traverse((o) => o.layers.set(OVERVIEW_LAYER));
		this.group.add(this.links, this.hot, this.fov, this.water.object, this.radio.object);
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

	// Where the drone's camera is pointed (fixed-wings keep their gimbal on the orbit centre).
	lookAt(id: string) {
		return this.units.get(id)?.centre ?? null;
	}

	heading(id: string) {
		return this.units.get(id)?.yaw ?? 0;
	}

	private altitude(role: Role, x: number, y: number, k: number) {
		if (role === "sky") {
			return Math.max(this.heights.base, this.heights.maxNear(x, y, 6)) + ALTITUDE_M.sky + (k % 2) * 15;
		}
		// Fly above the tallest thing around, staggered so drones don't sit on top of each other.
		return this.heights.maxNear(x, y, 3) + ALTITUDE_M[role] + (role === "echo" ? (k % 3) * 5 : 0);
	}

	setView(view: WorldView, units: Record<string, UnitInfo>, radio: RadioBeam[] = []) {
		this.radio.push(view.tick, radio);
		const seen = new Set<string>();
		view.agents.forEach((a, k) => {
			seen.add(a.id);
			const info = units[a.id] ?? { role: "echo", sensor: 7 };
			const cx = a.pos.x + 0.5;
			const cy = a.pos.y + 0.5;
			const { e, n } = this.frame.cellEN(cx, cy);
			let u = this.units.get(a.id);
			if (!u) {
				u = this.spawnUnit(a.id, info.role, new Vector3(e, this.altitude(info.role, cx, cy, k), n));
			}
			u.info = info;
			u.from.set(...this.enAlt(u));
			u.to.set(e, a.alive ? this.altitude(u.role, cx, cy, k) : u.to.y, n);
			u.t = 0;
			u.state = agentState(a);
			if (u.alive && !a.alive) {
				u.fallV = 0;
			}
			u.alive = a.alive;
			const colour = u.state === "normal" ? ROLE_COLOUR[u.role] : (MODE_COLOR[u.state] ?? ROLE_COLOUR[u.role]);
			u.drone.led.color.set(colour);
			(u.beacon.material as SpriteMaterial).color.set(colour);
			u.label.set(this.labelText(a.id, u), a.alive ? colour : C.dead);
		});
		for (const [id, u] of this.units) {
			if (!seen.has(id)) {
				this.group.remove(u.drone.object, u.beacon, u.hit, u.label.sprite);
				u.label.dispose();
				this.units.delete(id);
			}
		}
		this.linkPairs = view.links;
		this.setJams(view.jamZones);
	}

	private labelText(id: string, u: Unit) {
		if (!u.alive) {
			return `${id} · down`;
		}
		if (u.state === "jammed") {
			return `${id} · jammed`;
		}
		if (u.role === "water" && u.info.tank !== undefined) {
			const pct = Math.round(u.info.tank * 10) * 10;
			return `${id} · ${u.info.spraying ? "spraying" : u.info.phase === "refilling" ? "refilling" : "tank"} ${pct}%`;
		}
		return id;
	}

	// The sim centre back in EN + altitude terms, so the next tick blends from where we are.
	private enAlt(u: Unit): [number, number, number] {
		return [-u.centre.x, u.centre.y, u.centre.z];
	}

	private spawnUnit(id: string, role: Role, en: Vector3) {
		const drone = makeDrone(ROLE_COLOUR[role], role);
		const beacon = new Sprite(new SpriteMaterial({ map: this.dot, color: ROLE_COLOUR[role], depthTest: false, sizeAttenuation: false }));
		beacon.scale.setScalar(0.014);
		beacon.renderOrder = 10;
		const label = new Label(role === "echo" ? 0.022 : 0.026);
		const hit = new Mesh(this.hitGeo, this.hitMat);
		hit.scale.setScalar(role === "sky" ? 1.8 : 1);
		hit.userData.droneId = id;
		const centre = this.frame.world(en.x, en.z, en.y); // en is (east, alt, north)
		const u: Unit = {
			id,
			role,
			drone,
			beacon,
			label,
			hit,
			from: en.clone(),
			to: en.clone(),
			t: 1,
			centre,
			pos: centre.clone(),
			loiter: 0,
			orbit: Math.random() * Math.PI * 2,
			yaw: 0,
			bank: 0,
			alive: true,
			fallV: 0,
			state: "normal",
			info: { role, sensor: 7 },
		};
		drone.object.position.copy(centre);
		this.group.add(drone.object, beacon, hit, label.sprite);
		this.units.set(id, u);
		return u;
	}

	private setJams(zones: WorldView["jamZones"]) {
		const key = JSON.stringify(zones);
		if (key === this.jamKey) {
			return;
		}
		this.jamKey = key;
		for (const j of this.jams) {
			this.group.remove(j.group);
			j.label.dispose();
		}
		this.jams = zones.map((z) => {
			const r = z.radius * this.frame.m;
			const g = new Group();
			// Tall enough to swallow the high scouts too: the sim jams every altitude.
			const top = Math.max(r, ALTITUDE_M.sky + 60);
			const dome = new Mesh(
				this.domeGeo,
				new MeshBasicMaterial({ color: C.ember, transparent: true, opacity: 0.12, side: DoubleSide, depthWrite: false }),
			);
			dome.scale.set(r, top, r);
			const ring = new LineLoop(this.ringGeo, new LineBasicMaterial({ color: C.ember, depthWrite: false }));
			ring.scale.setScalar(r);
			ring.position.y = 1.5;
			const dashed = new LineLoop(this.ringGeo, new LineDashedMaterial({ color: C.ember, dashSize: 0.05, gapSize: 0.035, depthWrite: false }));
			dashed.computeLineDistances();
			dashed.scale.set(r, 1, r);
			dashed.position.y = top * 0.5;
			const label = new Label(0.026);
			label.set(`Jammer · ${Math.round(r)} m`, C.ember);
			label.sprite.position.y = top + 4;
			g.add(dome, ring, dashed, label.sprite);
			const { e, n } = this.frame.cellEN(z.center.x, z.center.y);
			this.frame.world(e, n, 0, g.position);
			this.group.add(g);
			return { group: g, centre: z.center, label };
		});
	}

	update(dt: number, now: number) {
		for (const u of this.units.values()) {
			this.fly(u, dt, now);
		}
		// Ground heights refine as tiles stream in; keep jammer domes seated.
		for (const j of this.jams) {
			j.group.position.y = this.heights.at(j.centre.x, j.centre.y);
		}
		this.updateLinks();
		this.updateFov();
		this.water.update(dt, this.sprays());
		this.radio.update(dt, (id) => {
			const u = this.units.get(id);
			return u?.alive ? u.pos : null;
		});
	}

	private fly(u: Unit, dt: number, now: number) {
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
		const cx = u.centre.x;
		const cz = u.centre.z;
		this.frame.world(e, n, alt, u.centre);
		const simSpeed = Math.hypot(u.centre.x - cx, u.centre.z - cz) / Math.max(dt, 1e-3);

		u.pos.copy(u.centre);
		if (u.drone.fixedWing && u.alive) {
			// A fixed-wing can't hover: circle the station, straightening out when it has somewhere to be.
			const want = simSpeed > 20 ? 0 : LOITER_M;
			u.loiter += (want - u.loiter) * Math.min(1, dt * 0.6);
			u.orbit += (LOITER_MS / LOITER_M) * dt;
			u.pos.x += Math.cos(u.orbit) * u.loiter;
			u.pos.z += Math.sin(u.orbit) * u.loiter;
		}

		const vx = (u.pos.x - prevX) / Math.max(dt, 1e-3);
		const vz = (u.pos.z - prevZ) / Math.max(dt, 1e-3);
		const speed = Math.hypot(vx, vz);
		let turn = 0;
		if (speed > 0.5 && u.alive) {
			const target = Math.atan2(vx, vz);
			let d = target - u.yaw;
			d = Math.atan2(Math.sin(d), Math.cos(d));
			const step = d * Math.min(1, dt * 4);
			u.yaw += step;
			turn = step / Math.max(dt, 1e-3);
		}

		const o = u.drone.object;
		o.position.copy(u.pos);
		o.rotation.set(0, u.yaw, 0);
		if (u.drone.fixedWing) {
			// Bank into the turn.
			u.bank += (Math.max(-0.6, Math.min(0.6, -turn * 0.8)) - u.bank) * Math.min(1, dt * 3);
			o.rotateZ(u.bank);
		} else {
			// Nose dips with speed, like a real multirotor.
			o.rotateX(Math.min(0.35, speed * 0.02));
		}
		if (!u.alive) {
			o.rotation.z = 0.6;
		}
		const flash = u.state === "jammed" ? Math.sin(now * 12) > 0 : true;
		u.drone.led.visible = flash;
		for (const r of u.drone.rotors) {
			r.rotation.y += u.alive ? dt * 60 : 0;
		}
		const lift = u.role === "sky" ? 8 : u.role === "water" ? 5 : 3;
		u.beacon.position.copy(u.pos).setY(u.pos.y + lift);
		u.beacon.visible = u.alive;
		u.label.sprite.position.copy(u.pos).setY(u.pos.y + lift + 1);
		u.hit.position.copy(u.pos);
	}

	private sprays() {
		const out: { from: Vector3; to: Vector3; heading: number }[] = [];
		for (const u of this.units.values()) {
			const aim = u.info.aim;
			if (u.role !== "water" || !u.alive || !u.info.spraying || !aim) {
				continue;
			}
			const { e, n } = this.frame.cellEN(aim.x + 0.5, aim.y + 0.5);
			const to = this.frame.world(e, n, this.heights.at(aim.x, aim.y) + 0.5);
			const from = u.pos.clone().setY(u.pos.y - 1.6);
			out.push({ from, to, heading: u.yaw });
		}
		return out;
	}

	private updateLinks() {
		let k = 0;
		let h = 0;
		for (const [a, b] of this.linkPairs) {
			const pa = this.units.get(a)?.pos;
			const pb = this.units.get(b)?.pos;
			if (!pa || !pb || k >= MAX_LINKS) {
				continue;
			}
			const seg = [pa.x, pa.y, pa.z, pb.x, pb.y, pb.z];
			if (this.selected && (a === this.selected || b === this.selected)) {
				this.hotPos.set(seg, h * 6);
				h++;
				continue;
			}
			this.linkPos.set(seg, k * 6);
			k++;
		}
		const geo = this.links.geometry;
		geo.setDrawRange(0, k * 2);
		geo.attributes.position.needsUpdate = true;
		this.hot.geometry.setDrawRange(0, h * 2);
		this.hot.geometry.attributes.position.needsUpdate = true;
	}

	// The selected drone's camera: a pyramid from the lens down to the exact square the sim lets it see.
	private updateFov() {
		const u = this.selected ? this.units.get(this.selected) : null;
		if (!u || !u.alive) {
			this.fov.visible = false;
			return;
		}
		const c = this.frame.cellOf(u.centre);
		const ground = this.heights.at(c.x, c.y);
		const h = Math.max(1, u.pos.y - ground);
		const half = (u.info.sensor + 0.5) * this.frame.m;
		const colour = ROLE_COLOUR[u.role];
		(this.fovFaces.material as MeshBasicMaterial).color.set(colour);
		(this.fovEdges.material as LineDashedMaterial).color.set(colour);
		(this.fovFoot.material as LineBasicMaterial).color.set(colour);
		this.fov.visible = true;
		this.fov.position.copy(u.pos);
		// Fixed-wings orbit off-centre: shear the pyramid so its base stays on the gimbal's target.
		const dx = u.centre.x - u.pos.x;
		const dz = u.centre.z - u.pos.z;
		this.fov.scale.set(half, h, half);
		this.fov.updateMatrix();
		this.fov.matrixAutoUpdate = false;
		const m = this.fov.matrix.elements;
		m[4] = -dx; // y column: moving down one unit (scaled to h) also slides the base toward the centre
		m[6] = -dz;
		this.fov.matrixWorldNeedsUpdate = true;
	}

	dispose() {
		this.dot.dispose();
		this.hitGeo.dispose();
		this.domeGeo.dispose();
		this.ringGeo.dispose();
		this.links.geometry.dispose();
		this.hot.geometry.dispose();
		this.fovFaces.geometry.dispose();
		this.fovEdges.geometry.dispose();
		this.fovFoot.geometry.dispose();
		this.water.dispose();
		this.radio.dispose();
		for (const u of this.units.values()) {
			u.label.dispose();
		}
		for (const j of this.jams) {
			j.label.dispose();
		}
	}
}
