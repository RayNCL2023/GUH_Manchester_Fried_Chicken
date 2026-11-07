// Water drones' jets: droplets thrown ballistically from the nozzle onto the aim point, breaking into
// spray and steam where they land.
import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	DynamicDrawUsage,
	Group,
	Points,
	PointsMaterial,
	Vector3,
} from "three";

const DROPS = 700;
const MIST = 160;
const G = 9.8;
const FLIGHT_S = 0.9; // nozzle to ground
const DROPS_PER_S = 380; // per jet
const MIST_PER_S = 50;

function softDot() {
	const c = document.createElement("canvas");
	c.width = c.height = 64;
	const ctx = c.getContext("2d")!;
	const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
	g.addColorStop(0, "rgba(255,255,255,1)");
	g.addColorStop(0.4, "rgba(255,255,255,0.6)");
	g.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 64, 64);
	return new CanvasTexture(c);
}

type Pool = { pos: Float32Array; vel: Float32Array; life: Float32Array; floor: Float32Array; next: number; points: Points };

function pool(n: number, mat: PointsMaterial): Pool {
	const pos = new Float32Array(n * 3).fill(-1e5);
	const geo = new BufferGeometry();
	geo.setAttribute("position", new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage));
	const points = new Points(geo, mat);
	points.frustumCulled = false;
	return { pos, vel: new Float32Array(n * 3), life: new Float32Array(n), floor: new Float32Array(n), next: 0, points };
}

export type Jet = { from: Vector3; to: Vector3; heading: number };

export class WaterFX {
	readonly object = new Group();
	private tex = softDot();
	private drops: Pool;
	private mist: Pool;
	private dropDebt = 0;
	private mistDebt = 0;

	constructor() {
		this.drops = pool(
			DROPS,
			new PointsMaterial({ map: this.tex, color: 0xcfe9ff, size: 1.3, transparent: true, opacity: 0.85, depthWrite: false }),
		);
		this.mist = pool(
			MIST,
			new PointsMaterial({ map: this.tex, color: 0xffffff, size: 7, transparent: true, opacity: 0.22, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true }),
		);
		this.object.add(this.drops.points, this.mist.points);
	}

	update(dt: number, jets: Jet[]) {
		this.dropDebt += DROPS_PER_S * dt * jets.length;
		this.mistDebt += MIST_PER_S * dt * jets.length;
		for (const jet of jets) {
			const share = 1 / jets.length;
			this.emitDrops(jet, Math.floor(this.dropDebt * share));
			this.emitMist(jet, Math.floor(this.mistDebt * share));
		}
		this.dropDebt -= Math.floor(this.dropDebt);
		this.mistDebt -= Math.floor(this.mistDebt);
		this.stepDrops(dt);
		this.stepMist(dt);
	}

	private emitDrops(jet: Jet, n: number) {
		const p = this.drops;
		const { from, to } = jet;
		// Launch velocity that lands on the aim point after FLIGHT_S, with a little cone spread.
		const vx = (to.x - from.x) / FLIGHT_S;
		const vy = (to.y - from.y) / FLIGHT_S + 0.5 * G * FLIGHT_S;
		const vz = (to.z - from.z) / FLIGHT_S;
		for (let k = 0; k < n; k++) {
			const i = p.next;
			p.next = (p.next + 1) % DROPS;
			p.pos.set([from.x, from.y, from.z], i * 3);
			const s = 0.09;
			p.vel.set([vx * (1 + (Math.random() - 0.5) * s) + (Math.random() - 0.5) * 1.6, vy * (1 + (Math.random() - 0.5) * s), vz * (1 + (Math.random() - 0.5) * s) + (Math.random() - 0.5) * 1.6], i * 3);
			p.life[i] = FLIGHT_S * 1.6;
			p.floor[i] = to.y;
		}
	}

	private emitMist(jet: Jet, n: number) {
		const p = this.mist;
		for (let k = 0; k < n; k++) {
			const i = p.next;
			p.next = (p.next + 1) % MIST;
			const a = Math.random() * Math.PI * 2;
			const r = Math.random() * 6;
			p.pos.set([jet.to.x + Math.cos(a) * r, jet.to.y + Math.random(), jet.to.z + Math.sin(a) * r], i * 3);
			p.vel.set([Math.cos(a) * 1.5, 2 + Math.random() * 3, Math.sin(a) * 1.5], i * 3);
			p.life[i] = 1.5 + Math.random() * 1.5;
		}
	}

	private stepDrops(dt: number) {
		const p = this.drops;
		for (let i = 0; i < DROPS; i++) {
			if (p.life[i] <= 0) {
				continue;
			}
			p.life[i] -= dt;
			const j = i * 3;
			p.vel[j + 1] -= G * dt;
			p.pos[j] += p.vel[j] * dt;
			p.pos[j + 1] += p.vel[j + 1] * dt;
			p.pos[j + 2] += p.vel[j + 2] * dt;
			if (p.life[i] <= 0 || p.pos[j + 1] < p.floor[i]) {
				p.life[i] = 0;
				p.pos[j + 1] = -1e5;
			}
		}
		p.points.geometry.attributes.position.needsUpdate = true;
	}

	private stepMist(dt: number) {
		const p = this.mist;
		for (let i = 0; i < MIST; i++) {
			if (p.life[i] <= 0) {
				continue;
			}
			p.life[i] -= dt;
			const j = i * 3;
			p.pos[j] += p.vel[j] * dt;
			p.pos[j + 1] += p.vel[j + 1] * dt;
			p.pos[j + 2] += p.vel[j + 2] * dt;
			if (p.life[i] <= 0) {
				p.pos[j + 1] = -1e5;
			}
		}
		p.points.geometry.attributes.position.needsUpdate = true;
	}

	dispose() {
		this.tex.dispose();
		for (const p of [this.drops, this.mist]) {
			p.points.geometry.dispose();
			(p.points.material as PointsMaterial).dispose();
		}
	}
}
