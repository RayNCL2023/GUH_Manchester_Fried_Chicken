// The ground station: a small lattice mast with a sector panel and a dish, sat on a landmark roof.
// Its beacon breathes in the flock colour while it can hear the drones and strobes red while jammed.
// Built from primitives, scaled up a little so it still reads from the orbit camera.
import {
	AdditiveBlending,
	BoxGeometry,
	Color,
	CylinderGeometry,
	Group,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	SphereGeometry,
	TorusGeometry,
	Vector3,
	type BufferGeometry,
	type Material,
	type Scene,
} from "three";
import { C } from "../pixel";
import type { Frame, Heightmap } from "./geo";

const SCALE = 2.2; // the real thing is ~8 m; this keeps it visible from ~700 m out
const MAST_M = 9;
const ON = new Color(C.flock);
const OFF = new Color(C.ember);

export class AntennaFX {
	readonly object = new Group();
	private beacon: MeshBasicMaterial;
	private halo: Mesh;
	private haloMat: MeshBasicMaterial;
	private geos: BufferGeometry[] = [];
	private mats: Material[] = [];
	private tip = new Vector3();
	private t = 0;
	jammed = false;

	constructor(
		private frame: Frame,
		private heights: Heightmap,
		private cell: { x: number; y: number },
	) {
		const steel = this.mat(new MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.7, roughness: 0.35 }));
		const dark = this.mat(new MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.4, roughness: 0.6 }));
		const white = this.mat(new MeshStandardMaterial({ color: 0xf2f2ee, metalness: 0.1, roughness: 0.5 }));

		const g = new Group();
		// Equipment cabinet on the roof.
		g.add(this.mesh(new BoxGeometry(2.4, 1.4, 1.6), dark, 0, 0.7, 0));
		// Three-legged lattice mast, tapering.
		for (let i = 0; i < 3; i++) {
			const a = (i / 3) * Math.PI * 2;
			const leg = this.mesh(new CylinderGeometry(0.06, 0.09, MAST_M, 6), steel, Math.cos(a) * 0.45, MAST_M / 2, Math.sin(a) * 0.45);
			leg.rotation.set(Math.sin(a) * 0.04, 0, -Math.cos(a) * 0.04);
			g.add(leg);
		}
		for (let k = 1; k < 6; k++) {
			const ring = this.mesh(new TorusGeometry(0.5 - k * 0.04, 0.035, 4, 12), steel, 0, (k * MAST_M) / 6, 0);
			ring.rotation.x = Math.PI / 2;
			g.add(ring);
		}
		// Sector panels facing three ways, and a backhaul dish.
		for (let i = 0; i < 3; i++) {
			const a = (i / 3) * Math.PI * 2;
			const p = this.mesh(new BoxGeometry(0.35, 1.6, 0.12), white, Math.cos(a) * 0.7, MAST_M - 1.4, Math.sin(a) * 0.7);
			p.rotation.y = -a + Math.PI / 2;
			g.add(p);
		}
		const dish = this.mesh(new SphereGeometry(0.75, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3), white, 0, MAST_M - 3.2, 0.55);
		dish.rotation.x = Math.PI / 2;
		g.add(dish);
		// Whip on top, then the beacon.
		g.add(this.mesh(new CylinderGeometry(0.03, 0.03, 2.2, 4), steel, 0, MAST_M + 1.1, 0));
		this.beacon = this.mat(new MeshBasicMaterial({ color: ON.clone() })) as MeshBasicMaterial;
		g.add(this.mesh(new SphereGeometry(0.28, 12, 8), this.beacon, 0, MAST_M + 2.3, 0));
		this.haloMat = this.mat(
			new MeshBasicMaterial({ color: ON.clone(), transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false }),
		) as MeshBasicMaterial;
		this.halo = this.mesh(new SphereGeometry(1, 16, 10), this.haloMat, 0, MAST_M + 2.3, 0);
		g.add(this.halo);

		g.scale.setScalar(SCALE);
		this.object.add(g);
		this.place();
	}

	private mat(m: Material) {
		this.mats.push(m);
		return m;
	}

	private mesh(geo: BufferGeometry, mat: Material, x: number, y: number, z: number) {
		this.geos.push(geo);
		const m = new Mesh(geo, mat);
		m.position.set(x, y, z);
		return m;
	}

	// Sit on the highest surface under the mast (the roof, once the tiles have loaded).
	private place() {
		const { e, n } = this.frame.cellEN(this.cell.x, this.cell.y);
		const roof = this.heights.maxNear(Math.round(this.cell.x), Math.round(this.cell.y), 1);
		this.frame.world(e, n, Number.isFinite(roof) ? roof : this.heights.base, this.object.position);
		this.tip.copy(this.object.position).setY(this.object.position.y + (MAST_M + 2.3) * SCALE);
	}

	// Where radio beams to and from the ground station start.
	position() {
		return this.tip;
	}

	addTo(scene: Scene) {
		scene.add(this.object);
	}

	update(dt: number) {
		this.t += dt;
		this.place();
		const c = this.jammed ? OFF : ON;
		// Breathing when healthy, a hard strobe when jammed.
		const k = this.jammed ? (Math.sin(this.t * 18) > 0 ? 1 : 0.15) : 0.6 + 0.4 * Math.sin(this.t * 3);
		this.beacon.color.copy(c).multiplyScalar(0.5 + k);
		this.haloMat.color.copy(c);
		this.haloMat.opacity = 0.15 + 0.3 * k;
		this.halo.scale.setScalar(0.8 + k * 0.9);
	}

	dispose() {
		this.object.removeFromParent();
		this.geos.forEach((g) => g.dispose());
		this.mats.forEach((m) => m.dispose());
	}
}
