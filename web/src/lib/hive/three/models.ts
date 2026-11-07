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

export type Kind = "car" | "fireEngine" | "drone";

// Fill these as models get downloaded, e.g. car: [{ url: "/models/cars/fiesta.glb", length: 4.1 }].
// rotateY corrects models that don't face +Z.
type ModelFile = { url: string; length: number; rotateY?: number };
export const MODEL_FILES: Record<Kind, ModelFile[]> = {
	car: [],
	fireEngine: [],
	drone: [],
};

const templates: Partial<Record<Kind, Object3D[]>> = {};
const loader = new GLTFLoader();

// Loads whatever GLBs are listed; missing files just leave the procedural fallback in place.
export async function loadModels() {
	await Promise.all(
		(Object.keys(MODEL_FILES) as Kind[]).map(async (kind) => {
			const loaded = await Promise.all(
				MODEL_FILES[kind].map((f) =>
					loader
						.loadAsync(f.url)
						.then((g) => normalise(g.scene, f))
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
	return cloneSkinned(list[Math.floor(Math.random() * list.length)]);
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

export type Drone = { object: Object3D; rotors: Object3D[]; led: MeshBasicMaterial };

const DRONE_SCALE = 3; // real ~0.5 m; scaled up so the flock reads from a few hundred metres
const droneBody = new MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.4 });
const droneArm = new MeshStandardMaterial({ color: 0x3b3f47, roughness: 0.6 });
const discGeo = new CircleGeometry(0.3, 20).rotateX(-Math.PI / 2);
const bladeGeo = new BoxGeometry(0.58, 0.01, 0.05);
const discMat = new MeshBasicMaterial({ color: 0xcfd6e0, transparent: true, opacity: 0.18, side: DoubleSide, depthWrite: false });
const motorGeo = new CylinderGeometry(0.05, 0.06, 0.08, 10);

export function makeDrone(colour: string): Drone {
	const g = new Group();
	const led = new MeshBasicMaterial({ color: new Color(colour) });
	const fromFile = fromTemplate("drone");
	const rotors: Object3D[] = [];

	if (fromFile) {
		g.add(fromFile);
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
	g.scale.setScalar(DRONE_SCALE);
	return { object: g, rotors, led };
}
