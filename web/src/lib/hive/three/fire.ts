// 3D fire: flames, embers and drifting smoke as camera-facing particles, plus glow and char on the ground.
// Driven by the sim's cell states; wind bends flames and carries smoke.
import {
	AdditiveBlending,
	CanvasTexture,
	Color,
	DynamicDrawUsage,
	InstancedBufferAttribute,
	InstancedBufferGeometry,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	NormalBlending,
	Object3D,
	PlaneGeometry,
	PointLight,
	Quaternion,
	ShaderMaterial,
	Vector3,
	type Blending,
	type Scene,
	type Texture,
} from "three";
import type { CellState, Vec } from "../../../../../shared/types";
import type { Frame, Heightmap } from "./geo";
import type { Scorch } from "./scorch";

const WIND_MS = 4; // metres per second per unit of sim wind

function puffTexture() {
	const size = 128;
	const c = document.createElement("canvas");
	c.width = c.height = size;
	const ctx = c.getContext("2d")!;
	for (let k = 0; k < 14; k++) {
		const r = size * (0.12 + Math.random() * 0.18);
		const x = size / 2 + (Math.random() - 0.5) * size * 0.4;
		const y = size / 2 + (Math.random() - 0.5) * size * 0.4;
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		g.addColorStop(0, "rgba(255,255,255,0.55)");
		g.addColorStop(1, "rgba(255,255,255,0)");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
	}
	// Fade the square's edges so no corner ever shows.
	ctx.globalCompositeOperation = "destination-in";
	const mask = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size / 2);
	mask.addColorStop(0, "rgba(0,0,0,1)");
	mask.addColorStop(1, "rgba(0,0,0,0)");
	ctx.fillStyle = mask;
	ctx.fillRect(0, 0, size, size);
	return new CanvasTexture(c);
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iData; // size, alpha, heat, rotation
varying vec2 vUv;
varying vec4 vData;
uniform float uStretch;
void main() {
	vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
	float c = cos(iData.w), s = sin(iData.w);
	vec2 q = position.xy * vec2(1.0, uStretch);
	mv.xy += mat2(c, s, -s, c) * q * iData.x;
	gl_Position = projectionMatrix * mv;
	vUv = position.xy + 0.5;
	vData = iData;
}`;

const FLAME_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vData;
void main() {
	float a = texture2D(uMap, vUv).a * vData.y;
	float heat = vData.z;
	vec3 col = mix(vec3(0.75, 0.08, 0.0), vec3(1.0, 0.55, 0.1), smoothstep(0.0, 0.6, heat));
	col = mix(col, vec3(1.0, 0.93, 0.7), smoothstep(0.7, 1.0, heat));
	gl_FragColor = vec4(col * a * 1.6, a);
}`;

const SMOKE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uFog;
varying vec2 vUv;
varying vec4 vData;
void main() {
	float a = texture2D(uMap, vUv).a * vData.y;
	// heat here = how fresh the smoke is: dark and sooty near the fire, paler as it spreads.
	vec3 col = mix(vec3(0.62, 0.62, 0.6), vec3(0.16, 0.14, 0.13), vData.z);
	gl_FragColor = vec4(col, a);
}`;

type Particles = {
	mesh: Mesh;
	pos: Float32Array;
	vel: Float32Array;
	age: Float32Array;
	life: Float32Array;
	size: Float32Array;
	rot: Float32Array;
	iPos: InstancedBufferAttribute;
	iData: InstancedBufferAttribute;
	cap: number;
	live: number;
};

function particles(cap: number, frag: string, map: Texture, blending: Blending, stretch: number): Particles {
	const geo = new InstancedBufferGeometry();
	const quad = new PlaneGeometry(1, 1);
	geo.index = quad.index;
	geo.setAttribute("position", quad.getAttribute("position"));
	const iPos = new InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(DynamicDrawUsage);
	const iData = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
	geo.setAttribute("iPos", iPos);
	geo.setAttribute("iData", iData);
	geo.instanceCount = 0;

	const mat = new ShaderMaterial({
		vertexShader: VERT,
		fragmentShader: frag,
		uniforms: { uMap: { value: map }, uStretch: { value: stretch }, uFog: { value: new Color() } },
		transparent: true,
		depthWrite: false,
		blending,
	});
	const mesh = new Mesh(geo, mat);
	mesh.frustumCulled = false;
	return {
		mesh,
		pos: new Float32Array(cap * 3),
		vel: new Float32Array(cap * 3),
		age: new Float32Array(cap),
		life: new Float32Array(cap),
		size: new Float32Array(cap),
		rot: new Float32Array(cap),
		iPos,
		iData,
		cap,
		live: 0,
	};
}

function spawn(p: Particles, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number) {
	if (p.live >= p.cap) {
		return;
	}
	const i = p.live++;
	p.pos.set([x, y, z], i * 3);
	p.vel.set([vx, vy, vz], i * 3);
	p.age[i] = 0;
	p.life[i] = life;
	p.size[i] = size;
	p.rot[i] = Math.random() * Math.PI * 2;
}

// Swap-remove dead particles so the live ones stay packed at the front.
function kill(p: Particles, i: number) {
	const last = --p.live;
	if (i === last) {
		return;
	}
	p.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
	p.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
	p.age[i] = p.age[last];
	p.life[i] = p.life[last];
	p.size[i] = p.size[last];
	p.rot[i] = p.rot[last];
}

const _m = new Matrix4();
const _q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const _s = new Vector3();
const _p = new Vector3();

export class FireFX {
	readonly group = new Object3D();
	private flames: Particles;
	private smoke: Particles;
	private embers: Particles;
	private glow: InstancedMesh;
	private light = new PointLight(0xff7a2a, 0, 400, 1.2);
	private burning: number[] = [];
	private burntAt: Float32Array;
	private states: CellState[] = [];
	private wind: Vec = { x: 0, y: 0 };
	private tex = puffTexture();
	private t = 0;
	private spawnAcc = { flame: 0, smoke: 0, ember: 0 };

	constructor(
		private frame: Frame,
		private heights: Heightmap,
		private scorch: Scorch,
	) {
		const cells = frame.w * frame.h;
		this.burntAt = new Float32Array(cells).fill(-1);
		this.flames = particles(9000, FLAME_FRAG, this.tex, AdditiveBlending, 1.5);
		this.embers = particles(1500, FLAME_FRAG, this.tex, AdditiveBlending, 1);
		this.smoke = particles(5000, SMOKE_FRAG, this.tex, NormalBlending, 1);
		this.smoke.mesh.renderOrder = 2;
		this.flames.mesh.renderOrder = 3;
		this.embers.mesh.renderOrder = 3;

		const flat = new PlaneGeometry(1, 1);
		this.glow = new InstancedMesh(
			flat,
			new MeshBasicMaterial({ map: this.tex, color: 0xff6a1a, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }),
			cells,
		);
		this.glow.count = 0;
		this.glow.frustumCulled = false;

		this.group.add(this.glow, this.smoke.mesh, this.flames.mesh, this.embers.mesh, this.light);
	}

	addTo(scene: Scene) {
		scene.add(this.group);
	}

	// New sim tick.
	setCells(cells: CellState[], wind: Vec) {
		if (!cells.length) {
			return;
		}
		this.wind = wind;
		const prev = this.states;
		this.states = cells;
		this.burning = [];
		for (let i = 0; i < cells.length; i++) {
			if (cells[i] === "fire") {
				this.burning.push(i);
			} else if (cells[i] === "burnt" && prev[i] !== "burnt") {
				this.burntAt[i] = this.t;
			} else if (cells[i] !== "burnt") {
				this.burntAt[i] = -1;
			}
		}
		this.layoutGround();
	}

	private cellPos(i: number, out: Vector3, jitter = 0.8) {
		const { w, m } = this.frame;
		const x = (i % w) + 0.5 + (Math.random() - 0.5) * jitter;
		const y = Math.floor(i / w) + 0.5 + (Math.random() - 0.5) * jitter;
		const { e, n } = this.frame.cellEN(x, y);
		return this.frame.world(e, n, this.heights.at(x, y), out).setY(out.y + 0.1 * m);
	}

	private layoutGround() {
		const { m, w } = this.frame;
		let g = 0;
		for (const i of this.burning) {
			const { e, n } = this.frame.cellEN((i % w) + 0.5, Math.floor(i / w) + 0.5);
			this.frame.world(e, n, this.heights.at(i % w, Math.floor(i / w)) + 0.5, _p);
			_s.setScalar(m * 2.4);
			this.glow.setMatrixAt(g++, _m.compose(_p, _q, _s));
		}
		this.glow.count = g;
		this.glow.instanceMatrix.needsUpdate = true;
		this.scorch.set(this.states);
	}

	// Heights refine as tiles stream in; re-seat the ground decals now and then.
	relayout() {
		this.layoutGround();
	}

	centroid(): Vector3 | null {
		if (!this.burning.length) {
			return null;
		}
		const { w } = this.frame;
		let x = 0;
		let y = 0;
		for (const i of this.burning) {
			x += i % w;
			y += Math.floor(i / w);
		}
		x /= this.burning.length;
		y /= this.burning.length;
		const { e, n } = this.frame.cellEN(x + 0.5, y + 0.5);
		return this.frame.world(e, n, this.heights.at(x, y));
	}

	isBurning(cellX: number, cellY: number) {
		const { w, h } = this.frame;
		if (cellX < 0 || cellY < 0 || cellX >= w || cellY >= h) {
			return false;
		}
		return this.states[Math.floor(cellY) * w + Math.floor(cellX)] === "fire";
	}

	get fireCount() {
		return this.burning.length;
	}

	update(dt: number) {
		this.t += dt;
		this.scorch.update(dt);
		const { m } = this.frame;
		const wx = -this.wind.x * WIND_MS; // sim x is east, world +X is west
		const wz = -this.wind.y * WIND_MS; // sim y is south, world +Z is north
		const n = this.burning.length;

		// Spawn budgets scale with the fire, capped by the pools.
		this.spawnAcc.flame += n * 26 * dt;
		this.spawnAcc.ember += n * 2 * dt;
		this.spawnAcc.smoke += n * 1.6 * dt;

		if (n) {
			while (this.spawnAcc.flame >= 1) {
				this.spawnAcc.flame--;
				this.cellPos(this.burning[(Math.random() * n) | 0], _p);
				spawn(this.flames, _p.x, _p.y, _p.z, wx * 0.25, 2.5 + Math.random() * 3, wz * 0.25, 0.5 + Math.random() * 0.7, m * (0.7 + Math.random() * 0.7));
			}
			while (this.spawnAcc.ember >= 1) {
				this.spawnAcc.ember--;
				this.cellPos(this.burning[(Math.random() * n) | 0], _p);
				spawn(this.embers, _p.x, _p.y + m * 0.5, _p.z, wx * 0.6 + (Math.random() - 0.5) * 3, 5 + Math.random() * 6, wz * 0.6 + (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, 0.35 + Math.random() * 0.3);
			}
			while (this.spawnAcc.smoke >= 1) {
				this.spawnAcc.smoke--;
				this.cellPos(this.burning[(Math.random() * n) | 0], _p, 1.4);
				spawn(this.smoke, _p.x, _p.y + m * 0.8, _p.z, wx * 0.5, 3 + Math.random() * 2.5, wz * 0.5, 7 + Math.random() * 6, m * (1.2 + Math.random()));
			}
		} else {
			this.spawnAcc.flame = this.spawnAcc.ember = this.spawnAcc.smoke = 0;
		}

		// Recently burnt ground keeps smouldering for ~25 s.
		if (Math.random() < 0.6) {
			const i = (Math.random() * this.burntAt.length) | 0;
			const at = this.burntAt[i];
			if (at >= 0 && this.t - at < 25) {
				this.cellPos(i, _p, 1);
				spawn(this.smoke, _p.x, _p.y, _p.z, wx * 0.4, 1.5 + Math.random(), wz * 0.4, 6 + Math.random() * 4, m * 0.9);
			}
		}

		this.step(this.flames, dt, (age, life, i) => {
			const k = age / life;
			// Flames lean into the wind as they rise, then narrow and die.
			this.flames.vel[i * 3] += wx * 0.6 * dt;
			this.flames.vel[i * 3 + 2] += wz * 0.6 * dt;
			return { size: this.flames.size[i] * (1 - k * 0.55), alpha: Math.sin(Math.PI * Math.min(1, k * 1.4)) * 0.85, heat: 1 - k };
		});
		this.step(this.embers, dt, (age, life, i) => {
			const k = age / life;
			this.embers.vel[i * 3 + 1] -= 2.2 * dt;
			return { size: this.embers.size[i], alpha: (1 - k) * (0.6 + 0.4 * Math.sin(age * 30 + i)), heat: 0.85 - k * 0.5 };
		});
		this.step(this.smoke, dt, (age, life, i) => {
			const k = age / life;
			// Smoke slows its climb and spreads downwind.
			this.smoke.vel[i * 3] += (wx - this.smoke.vel[i * 3]) * 0.4 * dt;
			this.smoke.vel[i * 3 + 2] += (wz - this.smoke.vel[i * 3 + 2]) * 0.4 * dt;
			this.smoke.vel[i * 3 + 1] *= 1 - 0.12 * dt;
			return { size: this.smoke.size[i] * (1 + k * 5), alpha: Math.min(1, k * 6) * (1 - k) * 0.42, heat: 1 - k };
		});

		const c = this.centroid();
		if (c) {
			this.light.position.copy(c).setY(c.y + 25);
			this.light.intensity = Math.min(9000, n * 120) * (0.85 + Math.random() * 0.3);
		} else {
			this.light.intensity = 0;
		}
		// Ground glow flickers with the flames.
		(this.glow.material as MeshBasicMaterial).opacity = 0.75 + Math.sin(this.t * 13) * 0.08 + Math.random() * 0.1;
	}

	private step(p: Particles, dt: number, look: (age: number, life: number, i: number) => { size: number; alpha: number; heat: number }) {
		for (let i = p.live - 1; i >= 0; i--) {
			p.age[i] += dt;
			if (p.age[i] >= p.life[i]) {
				kill(p, i);
			}
		}
		const P = p.iPos.array as Float32Array;
		const D = p.iData.array as Float32Array;
		for (let i = 0; i < p.live; i++) {
			const o = i * 3;
			p.pos[o] += p.vel[o] * dt;
			p.pos[o + 1] += p.vel[o + 1] * dt;
			p.pos[o + 2] += p.vel[o + 2] * dt;
			p.rot[i] += dt * 0.4;
			const l = look(p.age[i], p.life[i], i);
			P[o] = p.pos[o];
			P[o + 1] = p.pos[o + 1];
			P[o + 2] = p.pos[o + 2];
			D[i * 4] = l.size;
			D[i * 4 + 1] = l.alpha;
			D[i * 4 + 2] = l.heat;
			D[i * 4 + 3] = p.rot[i];
		}
		(p.mesh.geometry as InstancedBufferGeometry).instanceCount = p.live;
		p.iPos.needsUpdate = true;
		p.iData.needsUpdate = true;
	}

	reset() {
		for (const p of [this.flames, this.smoke, this.embers]) {
			p.live = 0;
		}
		this.burntAt.fill(-1);
		this.scorch.clear();
	}

	dispose() {
		this.tex.dispose();
		for (const p of [this.flames, this.smoke, this.embers]) {
			p.mesh.geometry.dispose();
			(p.mesh.material as ShaderMaterial).dispose();
		}
		this.glow.dispose();
	}
}
