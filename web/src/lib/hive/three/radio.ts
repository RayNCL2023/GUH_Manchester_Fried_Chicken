// Radio traffic made visible: every message one drone gets through to another flies across as a glowing
// packet with a trail, coloured by what it carries. A drone whose transmissions a jammer swallows pulses
// red rings instead (nothing reaches anyone, so nothing flies). Drawn on top so it reads through buildings.
import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	Color,
	DynamicDrawUsage,
	Group,
	LineBasicMaterial,
	LineSegments,
	Points,
	ShaderMaterial,
	type Vector3,
} from "three";
import type { MsgKind } from "../../../../../shared/types";
import type { RadioBeam } from "../fireLive";
import { C } from "../pixel";

const MAX = 1200;
const FLIGHT_S = 0.38; // a bit under the 10 Hz tick so consecutive packets read as a stream
const RING_S = 0.7; // a jammed drone's pulse
const RING_EVERY_S = 0.5;
const RING_PX = 70;

type Style = { colour: Color; size: number; trail: number };

const STYLE: Record<MsgKind, Style> = {
	goal: { colour: new Color(C.amber), size: 15, trail: 1 },
	claim: { colour: new Color(C.text), size: 11, trail: 0.8 },
	release: { colour: new Color(C.text), size: 9, trail: 0.6 },
	map: { colour: new Color(C.flock), size: 10, trail: 0.75 },
	chatter: { colour: new Color(C.glow), size: 9, trail: 0.6 },
	heartbeat: { colour: new Color(C.flock).multiplyScalar(0.55), size: 6, trail: 0.35 },
};
const RED = new Color(C.ember);

type Packet = { from: string; to: string; style: Style; age: number };
type Ring = { id: string; age: number };

const VERT = /* glsl */ `
attribute float size;
attribute vec3 tint;
attribute float ring;
varying vec3 vTint;
varying float vRing;
uniform float pixelRatio;
void main() {
	vTint = tint;
	vRing = ring;
	gl_PointSize = size * pixelRatio;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vTint;
varying float vRing;
void main() {
	float d = length(gl_PointCoord - 0.5);
	if (vRing > 0.5) {
		float band = smoothstep(0.08, 0.0, abs(d - 0.42));
		gl_FragColor = vec4(vTint * band * 1.6, 1.0);
		return;
	}
	float core = smoothstep(0.5, 0.0, d);
	gl_FragColor = vec4(vTint * (core + core * core * 1.5), 1.0);
}`;

export class RadioFX {
	readonly object = new Group();
	private packets: Packet[] = [];
	private rings: Ring[] = [];
	private lastRing = new Map<string, number>();
	private clock = 0;
	private lastTick = -1;
	private headPos = new Float32Array(MAX * 3);
	private headTint = new Float32Array(MAX * 3);
	private headSize = new Float32Array(MAX);
	private headRing = new Float32Array(MAX);
	private trailPos = new Float32Array(MAX * 6);
	private trailCol = new Float32Array(MAX * 6);
	private heads: Points;
	private trails: LineSegments;

	constructor() {
		const hg = new BufferGeometry();
		hg.setAttribute("position", new BufferAttribute(this.headPos, 3).setUsage(DynamicDrawUsage));
		hg.setAttribute("tint", new BufferAttribute(this.headTint, 3).setUsage(DynamicDrawUsage));
		hg.setAttribute("size", new BufferAttribute(this.headSize, 1).setUsage(DynamicDrawUsage));
		hg.setAttribute("ring", new BufferAttribute(this.headRing, 1).setUsage(DynamicDrawUsage));
		hg.setDrawRange(0, 0);
		this.heads = new Points(
			hg,
			new ShaderMaterial({
				vertexShader: VERT,
				fragmentShader: FRAG,
				uniforms: { pixelRatio: { value: Math.min(2, window.devicePixelRatio) } },
				blending: AdditiveBlending,
				transparent: true,
				depthTest: false,
				depthWrite: false,
			}),
		);
		const tg = new BufferGeometry();
		tg.setAttribute("position", new BufferAttribute(this.trailPos, 3).setUsage(DynamicDrawUsage));
		tg.setAttribute("color", new BufferAttribute(this.trailCol, 3).setUsage(DynamicDrawUsage));
		tg.setDrawRange(0, 0);
		this.trails = new LineSegments(
			tg,
			new LineBasicMaterial({ vertexColors: true, blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false }),
		);
		for (const o of [this.heads, this.trails]) {
			o.frustumCulled = false;
			o.renderOrder = 20;
		}
		this.object.add(this.trails, this.heads);
	}

	// One batch per sim tick (snapshots taken outside a step repeat the last batch: ignore those).
	push(tick: number, beams: RadioBeam[]) {
		if (tick === this.lastTick) {
			return;
		}
		this.lastTick = tick;
		for (const b of beams) {
			if (!b.ok) {
				// One pulse per jammed sender, not one per peer it failed to reach.
				if (this.clock - (this.lastRing.get(b.from) ?? -1e9) >= RING_EVERY_S) {
					this.lastRing.set(b.from, this.clock);
					this.rings.push({ id: b.from, age: 0 });
				}
				continue;
			}
			if (this.packets.length < MAX) {
				this.packets.push({ from: b.from, to: b.to, style: STYLE[b.kind], age: 0 });
			}
		}
	}

	update(dt: number, where: (id: string) => Vector3 | null) {
		this.clock += dt;
		let n = 0;
		let lines = 0;
		const keep: Packet[] = [];
		for (const p of this.packets) {
			p.age += dt;
			const t = p.age / FLIGHT_S;
			const a = where(p.from);
			const b = where(p.to);
			if (t >= 1 || !a || !b) {
				continue;
			}
			keep.push(p);
			const k = Math.min(1, t);
			const head = [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k];
			const fade = 1 - Math.max(0, t - 0.8) / 0.2;
			const tail = Math.max(0, k - 0.35 * p.style.trail);
			const tailP = [a.x + (b.x - a.x) * tail, a.y + (b.y - a.y) * tail, a.z + (b.z - a.z) * tail];
			const c = p.style.colour;

			this.headPos.set(head, n * 3);
			this.headTint.set([c.r * fade, c.g * fade, c.b * fade], n * 3);
			this.headSize[n] = p.style.size;
			this.headRing[n] = 0;
			this.trailPos.set([...tailP, ...head], lines * 6);
			const tf = fade * p.style.trail;
			this.trailCol.set([0, 0, 0, c.r * tf, c.g * tf, c.b * tf], lines * 6);
			n++;
			lines++;
		}
		this.rings = this.rings.filter((r) => {
			r.age += dt;
			const at = where(r.id);
			if (r.age >= RING_S || !at || n >= MAX) {
				return false;
			}
			const t = r.age / RING_S;
			const fade = 1 - t;
			this.headPos.set([at.x, at.y, at.z], n * 3);
			this.headTint.set([RED.r * fade, RED.g * fade, RED.b * fade], n * 3);
			this.headSize[n] = 12 + t * RING_PX;
			this.headRing[n] = 1;
			n++;
			return true;
		});
		this.packets = keep;
		const hg = this.heads.geometry;
		hg.setDrawRange(0, n);
		for (const k of ["position", "tint", "size", "ring"]) {
			hg.attributes[k].needsUpdate = true;
		}
		const tg = this.trails.geometry;
		tg.setDrawRange(0, lines * 2);
		tg.attributes.position.needsUpdate = true;
		tg.attributes.color.needsUpdate = true;
	}

	clear() {
		this.packets = [];
		this.rings = [];
	}

	dispose() {
		this.heads.geometry.dispose();
		(this.heads.material as ShaderMaterial).dispose();
		this.trails.geometry.dispose();
		(this.trails.material as LineBasicMaterial).dispose();
	}
}
