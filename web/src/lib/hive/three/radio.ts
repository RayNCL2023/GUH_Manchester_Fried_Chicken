// Radio traffic made visible as beams. Every message one drone gets through to another lights a beam
// straight from sender to receiver, with a bright pulse running down it; colour says what it carries.
// Transmissions a jammer swallows still show, in red and flickering, plus a red ring on the jammed sender.
// Beams are screen-space quads of a fixed pixel width (WebGL lines are stuck at 1 px), drawn on top so
// the mesh reads through buildings. All buffers are fixed-size: nothing is allocated per frame.
import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	Color,
	DynamicDrawUsage,
	Group,
	InstancedBufferAttribute,
	InstancedBufferGeometry,
	Mesh,
	Points,
	ShaderMaterial,
	Vector4,
	type Vector3,
} from "three";
import type { MsgKind } from "../../../../../shared/types";
import type { RadioBeam } from "../fireLive";
import { C } from "../pixel";

const MAX_PACKETS = 1000;
const MAX_BEAMS = MAX_PACKETS * 2; // each packet: the beam + its pulse
const MAX_RINGS = 64;
const FLIGHT_S = 0.45; // pulse travel time, sender to receiver
const LINGER_S = 0.25; // the beam keeps glowing a moment after the pulse lands
const PULSE_LEN = 0.28; // fraction of the beam the pulse occupies
const RING_S = 0.7;
const RING_EVERY_S = 0.5;
const RING_PX = 70;

type Style = { colour: Color; width: number; glow: number };

const STYLE: Record<MsgKind, Style> = {
	goal: { colour: new Color(C.amber), width: 6, glow: 1 },
	claim: { colour: new Color(C.text), width: 4, glow: 0.85 },
	release: { colour: new Color(C.text), width: 3, glow: 0.6 },
	map: { colour: new Color(C.flock), width: 4, glow: 0.8 },
	chatter: { colour: new Color(C.glow), width: 3, glow: 0.6 },
	heartbeat: { colour: new Color(C.flock), width: 2, glow: 0.3 },
};
const RED = new Color(C.ember);
const JAMMED: Style = { colour: RED, width: 4, glow: 0.9 };

type Packet = { from: string; to: string; style: Style; age: number; jammed: boolean };
type Ring = { id: string; age: number };

const BEAM_VERT = /* glsl */ `
attribute vec3 iStart;
attribute vec3 iEnd;
attribute vec3 iColor;
attribute vec2 iShape; // width px, head (1 = brightest at the leading end)
uniform vec4 viewport; // x, y, w, h in device pixels
varying vec3 vColor;
varying float vAlong;
varying float vSide;
varying float vHead;
void main() {
	vec4 a = projectionMatrix * viewMatrix * vec4(iStart, 1.0);
	vec4 b = projectionMatrix * viewMatrix * vec4(iEnd, 1.0);
	if (a.w < 0.05 || b.w < 0.05) {
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // an end is behind the camera: skip
		return;
	}
	vec2 res = viewport.zw;
	vec2 sa = a.xy / a.w * res;
	vec2 sb = b.xy / b.w * res;
	vec2 dir = sb - sa;
	dir = length(dir) < 1e-4 ? vec2(1.0, 0.0) : normalize(dir);
	vec2 normal = vec2(-dir.y, dir.x);
	vec4 p = mix(a, b, position.x);
	p.xy += normal * position.y * iShape.x / res * p.w;
	gl_Position = p;
	vColor = iColor;
	vAlong = position.x;
	vSide = position.y;
	vHead = iShape.y;
}`;

const BEAM_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlong;
varying float vSide;
varying float vHead;
void main() {
	float s = 1.0 - abs(vSide);
	float body = s * s;
	float core = smoothstep(0.55, 1.0, s);
	float along = mix(1.0, vAlong * vAlong, vHead);
	gl_FragColor = vec4(vColor * (body * 0.7 + core * 1.3) * along, 1.0);
}`;

const RING_VERT = /* glsl */ `
attribute float size;
attribute vec3 tint;
varying vec3 vTint;
uniform float pixelRatio;
void main() {
	vTint = tint;
	gl_PointSize = size * pixelRatio;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RING_FRAG = /* glsl */ `
varying vec3 vTint;
void main() {
	float d = length(gl_PointCoord - 0.5);
	gl_FragColor = vec4(vTint * smoothstep(0.08, 0.0, abs(d - 0.42)) * 1.6, 1.0);
}`;

const _vp = new Vector4();

export class RadioFX {
	readonly object = new Group();
	private packets: Packet[] = [];
	private rings: Ring[] = [];
	private lastRing = new Map<string, number>();
	private clock = 0;
	private lastTick = -1;

	private start = new Float32Array(MAX_BEAMS * 3);
	private end = new Float32Array(MAX_BEAMS * 3);
	private colour = new Float32Array(MAX_BEAMS * 3);
	private shape = new Float32Array(MAX_BEAMS * 2);
	private beamGeo = new InstancedBufferGeometry();
	private beams: Mesh;

	private ringPos = new Float32Array(MAX_RINGS * 3);
	private ringTint = new Float32Array(MAX_RINGS * 3);
	private ringSize = new Float32Array(MAX_RINGS);
	private ringPoints: Points;

	constructor() {
		// Unit quad: x along the beam (0..1), y across it (-1..1).
		this.beamGeo.setIndex([0, 1, 2, 0, 2, 3]);
		this.beamGeo.setAttribute("position", new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
		const inst = (arr: Float32Array, size: number) => new InstancedBufferAttribute(arr, size).setUsage(DynamicDrawUsage);
		this.beamGeo.setAttribute("iStart", inst(this.start, 3));
		this.beamGeo.setAttribute("iEnd", inst(this.end, 3));
		this.beamGeo.setAttribute("iColor", inst(this.colour, 3));
		this.beamGeo.setAttribute("iShape", inst(this.shape, 2));
		this.beamGeo.instanceCount = 0;
		const beamMat = new ShaderMaterial({
			vertexShader: BEAM_VERT,
			fragmentShader: BEAM_FRAG,
			uniforms: { viewport: { value: new Vector4(0, 0, 1, 1) } },
			blending: AdditiveBlending,
			transparent: true,
			depthTest: false,
			depthWrite: false,
		});
		this.beams = new Mesh(this.beamGeo, beamMat);
		// Main view and the drone inset have different viewports: read the live one each draw.
		this.beams.onBeforeRender = (renderer) => {
			renderer.getCurrentViewport(_vp);
			beamMat.uniforms.viewport.value.copy(_vp);
		};

		const rg = new BufferGeometry();
		rg.setAttribute("position", new BufferAttribute(this.ringPos, 3).setUsage(DynamicDrawUsage));
		rg.setAttribute("tint", new BufferAttribute(this.ringTint, 3).setUsage(DynamicDrawUsage));
		rg.setAttribute("size", new BufferAttribute(this.ringSize, 1).setUsage(DynamicDrawUsage));
		rg.setDrawRange(0, 0);
		this.ringPoints = new Points(
			rg,
			new ShaderMaterial({
				vertexShader: RING_VERT,
				fragmentShader: RING_FRAG,
				uniforms: { pixelRatio: { value: Math.min(2, window.devicePixelRatio) } },
				blending: AdditiveBlending,
				transparent: true,
				depthTest: false,
				depthWrite: false,
			}),
		);
		for (const o of [this.beams, this.ringPoints]) {
			o.frustumCulled = false;
			o.renderOrder = 20;
		}
		this.object.add(this.beams, this.ringPoints);
	}

	// One batch per sim tick (snapshots taken outside a step repeat the last batch: ignore those).
	push(tick: number, beams: RadioBeam[]) {
		if (tick === this.lastTick) {
			return;
		}
		this.lastTick = tick;
		for (const b of beams) {
			// One ring per jammed sender, not one per peer it failed to reach.
			if (!b.ok && this.clock - (this.lastRing.get(b.from) ?? -1e9) >= RING_EVERY_S) {
				this.lastRing.set(b.from, this.clock);
				this.rings.push({ id: b.from, age: 0 });
			}
			if (this.packets.length < MAX_PACKETS) {
				this.packets.push({ from: b.from, to: b.to, style: b.ok ? STYLE[b.kind] : JAMMED, age: 0, jammed: !b.ok });
			}
		}
	}

	private beam(i: number, a: Vector3, b: Vector3, k0: number, k1: number, c: Color, gain: number, width: number, head: number) {
		const j = i * 3;
		this.start[j] = a.x + (b.x - a.x) * k0;
		this.start[j + 1] = a.y + (b.y - a.y) * k0;
		this.start[j + 2] = a.z + (b.z - a.z) * k0;
		this.end[j] = a.x + (b.x - a.x) * k1;
		this.end[j + 1] = a.y + (b.y - a.y) * k1;
		this.end[j + 2] = a.z + (b.z - a.z) * k1;
		this.colour[j] = c.r * gain;
		this.colour[j + 1] = c.g * gain;
		this.colour[j + 2] = c.b * gain;
		this.shape[i * 2] = width;
		this.shape[i * 2 + 1] = head;
	}

	update(dt: number, where: (id: string) => Vector3 | null) {
		this.clock += dt;
		let n = 0;
		this.packets = this.packets.filter((p) => {
			p.age += dt;
			const a = where(p.from);
			const b = where(p.to);
			if (p.age >= FLIGHT_S + LINGER_S || !a || !b) {
				return false;
			}
			const s = p.style;
			const t = Math.min(1, p.age / FLIGHT_S);
			// The beam: lit the moment the packet leaves, fading once it has landed.
			let fade = p.age < FLIGHT_S ? 1 : 1 - (p.age - FLIGHT_S) / LINGER_S;
			// Jammed: the same beam to the peer it was meant for, red and stuttering like a garbled signal.
			if (p.jammed) {
				fade *= Math.sin(p.age * 70) > -0.2 ? 1 : 0.25;
			}
			this.beam(n++, a, b, 0, 1, s.colour, 0.28 * s.glow * fade, s.width * 0.6, 0);
			// The pulse: a bright slug running down the beam, brightest at its leading end.
			if (p.age < FLIGHT_S) {
				this.beam(n++, a, b, Math.max(0, t - PULSE_LEN), t, s.colour, 1.4 * s.glow, s.width * 1.6, 1);
			}
			return true;
		});
		this.beamGeo.instanceCount = n;
		for (const k of ["iStart", "iEnd", "iColor", "iShape"]) {
			this.beamGeo.attributes[k].needsUpdate = true;
		}

		let r = 0;
		this.rings = this.rings.filter((ring) => {
			ring.age += dt;
			const at = where(ring.id);
			if (ring.age >= RING_S || !at || r >= MAX_RINGS) {
				return false;
			}
			const t = ring.age / RING_S;
			const j = r * 3;
			this.ringPos[j] = at.x;
			this.ringPos[j + 1] = at.y;
			this.ringPos[j + 2] = at.z;
			this.ringTint[j] = RED.r * (1 - t);
			this.ringTint[j + 1] = RED.g * (1 - t);
			this.ringTint[j + 2] = RED.b * (1 - t);
			this.ringSize[r] = 12 + t * RING_PX;
			r++;
			return true;
		});
		const rg = this.ringPoints.geometry;
		rg.setDrawRange(0, r);
		for (const k of ["position", "tint", "size"]) {
			rg.attributes[k].needsUpdate = true;
		}
	}

	clear() {
		this.packets = [];
		this.rings = [];
	}

	dispose() {
		this.beamGeo.dispose();
		(this.beams.material as ShaderMaterial).dispose();
		this.ringPoints.geometry.dispose();
		(this.ringPoints.material as ShaderMaterial).dispose();
	}
}
