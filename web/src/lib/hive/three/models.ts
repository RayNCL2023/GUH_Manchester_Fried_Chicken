// Meshes for drones and vehicles. Procedural by default; drop a GLB into /public/models and list it in
// MODEL_FILES to swap it in (it gets scaled to the real-world length and faced along +Z).
import {
	Box3,
	BoxGeometry,
	CircleGeometry,
	Color,
	CylinderGeometry,
	DoubleSide,
	Group,
	Mesh,
	MeshBasicMaterial,
	MeshLambertMaterial,
	MeshStandardMaterial,
	SphereGeometry,
	Vector3,
	type Material,
	type Object3D,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

export type Kind = "car" | "fireEngine" | "drone" | "uav";

// GLBs in /public/models (credits in /public/models/CREDITS.md). length = real-world metres;
// weight = how often it turns up in traffic. All of these face +Z already.
type ModelFile = { url: string; length: number; weight?: number; rotateY?: number };
export const MODEL_FILES: Record<Kind, ModelFile[]> = {
	car: [
		{ url: "/models/cars/sedan.glb", length: 4.6, weight: 4 },
		{ url: "/models/cars/hatchback-sports.glb", length: 4.2, weight: 3 },
		{ url: "/models/cars/sedan-sports.glb", length: 4.6, weight: 2 },
		{ url: "/models/cars/suv.glb", length: 4.7, weight: 3 },
		{ url: "/models/cars/suv-luxury.glb", length: 4.9, weight: 2 },
		{ url: "/models/cars/taxi.glb", length: 4.6, weight: 2 },
		{ url: "/models/cars/van.glb", length: 5.3, weight: 2 },
		{ url: "/models/cars/delivery.glb", length: 6.5, weight: 1 },
		{ url: "/models/cars/truck.glb", length: 6.2, weight: 1 },
		{ url: "/models/cars/garbage-truck.glb", length: 8.5, weight: 0.5 },
		{ url: "/models/emergency/police.glb", length: 4.8, weight: 0.6 },
		{ url: "/models/emergency/ambulance.glb", length: 6.2, weight: 0.4 },
	],
	fireEngine: [{ url: "/models/emergency/firetruck.glb", length: 8 }],
	drone: [{ url: "/models/drones/quadcopter.glb", length: 0.6 }],
	// Predator-style fixed wing for the high scouts; nose along +Z (wings sit forward, pusher prop at -Z).
	uav: [{ url: "/models/drones/military-uav.glb", length: 14 }],
};

const ROTOR = /prop|rotor|blade/i;

const templates: Partial<Record<Kind, { object: Object3D; weight: number }[]>> = {};
const loader = new GLTFLoader();

let loading: Promise<void> | null = null;

// Loads whatever GLBs are listed (once per page); missing files just leave the procedural fallback in place.
export function loadModels() {
	loading ??= loadAll();
	return loading;
}

async function loadAll() {
	await Promise.all(
		(Object.keys(MODEL_FILES) as Kind[]).map(async (kind) => {
			const loaded = await Promise.all(
				MODEL_FILES[kind].map((f) =>
					loader
						.loadAsync(f.url)
						.then((g) => ({ object: normalise(g.scene, f), weight: f.weight ?? 1 }))
						.catch(() => null),
				),
			);
			const ok = loaded.filter((o) => o !== null);
			if (ok.length) {
				templates[kind] = ok;
			}
		}),
	);
}

function normalise(scene: Object3D, f: ModelFile) {
	// Some exports bake rotor vertices off-centre; move each rotor's pivot to its own centre so it spins in place.
	scene.traverse((o) => {
		if (!(o instanceof Mesh) || !ROTOR.test(o.name)) {
			return;
		}
		o.geometry.computeBoundingBox();
		const c = o.geometry.boundingBox!.getCenter(new Vector3());
		o.geometry = o.geometry.clone().translate(-c.x, -c.y, -c.z);
		o.position.add(c);
	});
	const box = new Box3().setFromObject(scene);
	const size = box.getSize(new Vector3());
	const scale = f.length / Math.max(size.x, size.z);
	const centre = box.getCenter(new Vector3());
	scene.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
	scene.scale.setScalar(scale);
	const wrap = new Group();
	wrap.add(scene);
	wrap.rotation.y = f.rotateY ?? 0;
	const outer = new Group();
	outer.add(wrap);
	return outer;
}

function fromTemplate(kind: Kind): Object3D | null {
	const list = templates[kind];
	if (!list?.length) {
		return null;
	}
	let r = Math.random() * list.reduce((sum, t) => sum + t.weight, 0);
	const pick = list.find((t) => (r -= t.weight) <= 0) ?? list[0];
	return cloneSkinned(pick.object);
}

// ---------- shared geometry ----------

const box = new BoxGeometry(1, 1, 1);
const wheelGeo = new CylinderGeometry(0.34, 0.34, 0.24, 12).rotateZ(Math.PI / 2);
const glass = new MeshStandardMaterial({ color: 0x1b2430, roughness: 0.15, metalness: 0.6 });
const tyre = new MeshLambertMaterial({ color: 0x151515 });
const paints = new Map<number, Material>();

// UK traffic is mostly white, black, grey and silver, with the odd colour.
export const CAR_COLOURS = [0xf2f2f2, 0xf2f2f2, 0x1a1a1a, 0x1a1a1a, 0x8a8f96, 0xb9bec4, 0xb9bec4, 0x1f3a6b, 0x8c1c1c, 0x2f4f3a];

function paint(c: number) {
	if (!paints.has(c)) {
		paints.set(c, new MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.5 }));
	}
	return paints.get(c)!;
}

function part(mat: Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) {
	const m = new Mesh(box, mat);
	m.scale.set(sx, sy, sz);
	m.position.set(x, y, z);
	return m;
}

function wheels(g: Group, halfTrack: number, axles: number[]) {
	for (const z of axles) {
		for (const x of [-halfTrack, halfTrack]) {
			const w = new Mesh(wheelGeo, tyre);
			w.position.set(x, 0.34, z);
			g.add(w);
		}
	}
}

// Faces +Z, origin on the ground at its centre.
export function makeCar(colour = CAR_COLOURS[Math.floor(Math.random() * CAR_COLOURS.length)]): Object3D {
	const fromFile = fromTemplate("car");
	if (fromFile) {
		return fromFile;
	}
	const g = new Group();
	const body = paint(colour);
	g.add(part(body, 1.78, 0.7, 4.3, 0, 0.68, 0));
	g.add(part(body, 1.6, 0.55, 2.2, 0, 1.3, -0.25));
	g.add(part(glass, 1.62, 0.42, 2.0, 0, 1.3, -0.25));
	wheels(g, 0.8, [1.35, -1.35]);
	return g;
}

export type FireEngine = { object: Object3D; beacons: Mesh[] };

const beaconMat = () => new MeshBasicMaterial({ color: 0x2b6bff });

export function makeFireEngine(): FireEngine {
	const fromFile = fromTemplate("fireEngine");
	const g = new Group();
	const beacons: Mesh[] = [];
	const sphere = new SphereGeometry(0.22, 8, 6);
	for (const x of [-0.7, 0.7]) {
		const b = new Mesh(sphere, beaconMat());
		b.position.set(x, 3.05, 2.6);
		beacons.push(b);
		g.add(b);
	}
	if (fromFile) {
		g.add(fromFile);
		const top = new Box3().setFromObject(fromFile);
		beacons.forEach((b) => b.position.set(b.position.x, top.max.y + 0.1, top.max.z * 0.55));
		return { object: g, beacons };
	}
	const red = paint(0xc8161d);
	g.add(part(red, 2.5, 2.3, 8, 0, 1.55, 0));
	g.add(part(paint(0xffd23a), 2.52, 0.2, 8.02, 0, 1.25, 0));
	g.add(part(glass, 2.3, 0.8, 0.1, 0, 2.15, 4.0));
	g.add(part(paint(0xb9bec4), 0.6, 0.25, 6, 0, 2.85, -0.5));
	wheels(g, 1.1, [2.6, -1.6, -2.9]);
	return { object: g, beacons };
}

// ---------- drone ----------

export type Drone = { object: Object3D; rotors: Object3D[]; led: MeshBasicMaterial; fixedWing: boolean };
export type DroneRole = "echo" | "sky" | "water";

const DRONE_SCALE = 3; // real ~0.5 m; scaled up so the flock reads from a few hundred metres
const WATER_SCALE = 5; // heavy-lift firefighter, ~2.5 m across with its tank
const tankMat = new MeshStandardMaterial({ color: 0xc8161d, roughness: 0.45, metalness: 0.3 });
const nozzleMat = new MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.3, metalness: 0.8 });
const tankGeo = new CylinderGeometry(0.11, 0.11, 0.42, 16).rotateX(Math.PI / 2);
const nozzleGeo = new CylinderGeometry(0.015, 0.025, 0.22, 8);

// Fixed-wing scout. Falls back to a simple cross-shaped airframe if the GLB is missing.
function makeUav(colour: string): Drone {
	const g = new Group();
	const led = new MeshBasicMaterial({ color: new Color(colour) });
	const fromFile = fromTemplate("uav");
	if (fromFile) {
		g.add(fromFile);
	} else {
		const body = paint(0xb9bec4);
		g.add(part(body, 0.9, 0.9, 8, 0, 0, 0));
		g.add(part(body, 14, 0.15, 1.1, 0, 0.2, 0.8));
		g.add(part(body, 3.5, 0.12, 0.7, 0, 0.3, -3.6));
	}
	const ledMesh = new Mesh(new SphereGeometry(0.35, 8, 6), led);
	ledMesh.position.set(0, -0.4, 1.5);
	g.add(ledMesh);
	return { object: g, rotors: [], led, fixedWing: true };
}
const droneBody = new MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.4 });
const droneArm = new MeshStandardMaterial({ color: 0x3b3f47, roughness: 0.6 });
const discGeo = new CircleGeometry(0.3, 20).rotateX(-Math.PI / 2);
const bladeGeo = new BoxGeometry(0.58, 0.01, 0.05);
const discMat = new MeshBasicMaterial({ color: 0xcfd6e0, transparent: true, opacity: 0.18, side: DoubleSide, depthWrite: false });
const motorGeo = new CylinderGeometry(0.05, 0.06, 0.08, 10);

export function makeDrone(colour: string, role: DroneRole = "echo"): Drone {
	if (role === "sky") {
		return makeUav(colour);
	}
	const g = new Group();
	const led = new MeshBasicMaterial({ color: new Color(colour) });
	const fromFile = fromTemplate("drone");
	const rotors: Object3D[] = [];

	if (fromFile) {
		g.add(fromFile);
		// Spin whatever the model calls its propellers.
		fromFile.traverse((o) => {
			if (ROTOR.test(o.name) && !rotors.some((r) => o.parent === r)) {
				rotors.push(o);
			}
		});
	} else {
		g.add(part(droneBody, 0.22, 0.09, 0.32, 0, 0, 0));
		for (const a of [Math.PI / 4, -Math.PI / 4]) {
			const arm = part(droneArm, 0.05, 0.03, 0.9, 0, 0, 0);
			arm.rotation.y = a;
			g.add(arm);
		}
		for (const [x, z] of [
			[0.32, 0.32],
			[-0.32, 0.32],
			[0.32, -0.32],
			[-0.32, -0.32],
		]) {
			const motor = new Mesh(motorGeo, droneBody);
			motor.position.set(x, 0.04, z);
			g.add(motor);
			const rotor = new Group();
			rotor.position.set(x, 0.09, z);
			rotor.add(new Mesh(discGeo, discMat), new Mesh(bladeGeo, droneArm));
			rotors.push(rotor);
			g.add(rotor);
		}
	}
	const ledMesh = new Mesh(new SphereGeometry(0.06, 8, 6), led);
	ledMesh.position.set(0, -0.06, 0.12);
	g.add(ledMesh);
	if (role === "water") {
		// Slung tank and a forward-angled nozzle under the airframe.
		const tank = new Mesh(tankGeo, tankMat);
		tank.position.set(0, -0.2, -0.05);
		const nozzle = new Mesh(nozzleGeo, nozzleMat);
		nozzle.position.set(0, -0.32, 0.18);
		nozzle.rotation.x = 0.6;
		g.add(tank, nozzle);
	}
	g.scale.setScalar(role === "water" ? WATER_SCALE : DRONE_SCALE);
	return { object: g, rotors, led, fixedWing: false };
}
