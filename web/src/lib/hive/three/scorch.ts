// Ash painted straight onto the ground meshes (Google tiles or blocks), so it coats roofs, walls and
// streets exactly instead of floating as decals. A per-cell burnt mask is sampled by world XZ in each
// material's fragment shader; world-space noise breaks the edge into a ragged, organic border.
import { DataTexture, LinearFilter, Mesh, RGFormat, UnsignedByteType, Vector3, type Material, type Object3D } from "three";
import type { CellState } from "../../../../../shared/types";
import type { Frame } from "./geo";

const PATCHED = Symbol("scorch");

const FRAG_HEAD = /* glsl */ `
uniform sampler2D uScorch;
uniform vec3 uScorchGrid; // w, h, metres per cell
varying vec2 vScorchW;
float scorchHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float scorchNoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(scorchHash(i), scorchHash(i + vec2(1, 0)), u.x), mix(scorchHash(i + vec2(0, 1)), scorchHash(i + vec2(1, 1)), u.x), u.y);
}
// x = edge mask, y = how charred the ground is (fades in over time).
vec2 scorchAmount() {
	// World (X west, Z north) → cell coords (x east, y south) → mask uv.
	vec2 cell = vec2(-vScorchW.x / uScorchGrid.z + uScorchGrid.x * 0.5, uScorchGrid.y * 0.5 - vScorchW.y / uScorchGrid.z);
	vec2 uv = cell / uScorchGrid.xy;
	if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec2(0.0);
	vec2 m = texture2D(uScorch, uv).rg;
	float mask = m.r;
	vec2 q = vScorchW / (uScorchGrid.z * 0.7);
	float n = 0.5 * scorchNoise(q) + 0.3 * scorchNoise(q * 2.3) + 0.2 * scorchNoise(q * 5.1);
	return vec2(smoothstep(0.47, 0.53, mask + (n - 0.5) * 0.7), m.g);
}
`;

// Seconds for freshly burnt ground to fully char.
const CHAR_S = 14;
const MAX_CHAR = 0.85;

export class Scorch {
	private data: Uint8Array;
	private target: Uint8Array;
	private level: Float32Array;
	private tex: DataTexture;
	private uniforms: Record<string, { value: unknown }>;

	constructor(private frame: Frame) {
		const cells = frame.w * frame.h;
		this.data = new Uint8Array(cells * 2);
		this.target = new Uint8Array(cells);
		this.level = new Float32Array(cells);
		this.tex = new DataTexture(this.data, frame.w, frame.h, RGFormat, UnsignedByteType);
		this.tex.magFilter = this.tex.minFilter = LinearFilter;
		this.tex.unpackAlignment = 1; // 2 bytes per texel: rows aren't 4-byte aligned for odd widths
		this.tex.needsUpdate = true;
		this.uniforms = { uScorch: { value: this.tex }, uScorchGrid: { value: new Vector3(frame.w, frame.h, frame.m) } };
	}

	// Sticky: once a cell has burnt it stays charred until clear() (scenario reset).
	set(states: CellState[]) {
		for (let i = 0; i < this.target.length; i++) {
			if (states[i] === "burnt") {
				this.target[i] = 1;
			}
		}
	}

	// Ramp each burnt cell's char up to MAX_CHAR, so ash creeps in behind the fire front. Never fades back.
	update(dt: number) {
		const step = dt / CHAR_S;
		let dirty = false;
		for (let i = 0; i < this.level.length; i++) {
			if (!this.target[i] || this.level[i] >= MAX_CHAR) {
				continue;
			}
			const next = Math.min(MAX_CHAR, this.level[i] + step);
			this.level[i] = next;
			this.data[i * 2] = 255;
			this.data[i * 2 + 1] = Math.round(next * 255);
			dirty = true;
		}
		if (dirty) {
			this.tex.needsUpdate = true;
		}
	}

	clear() {
		this.target.fill(0);
		this.level.fill(0);
		this.data.fill(0);
		this.tex.needsUpdate = true;
	}

	// Patch every mesh material under root (call again as new tiles stream in; already-patched ones are skipped).
	apply(root: Object3D) {
		root.traverse((o) => {
			if (!(o instanceof Mesh)) {
				return;
			}
			const mats: Material[] = Array.isArray(o.material) ? o.material : [o.material];
			mats.forEach((m) => this.patch(m));
		});
	}

	private patch(mat: Material) {
		const tagged = mat as Material & { [PATCHED]?: true };
		if (tagged[PATCHED]) {
			return;
		}
		tagged[PATCHED] = true;
		const prev = mat.onBeforeCompile;
		const uniforms = this.uniforms;
		mat.onBeforeCompile = function (shader, renderer) {
			prev.call(this, shader, renderer);
			Object.assign(shader.uniforms, uniforms);
			shader.vertexShader = `varying vec2 vScorchW;\n${shader.vertexShader}`.replace(
				"#include <project_vertex>",
				"#include <project_vertex>\nvScorchW = (modelMatrix * vec4(transformed, 1.0)).xz;",
			);
			shader.fragmentShader = `${FRAG_HEAD}\n${shader.fragmentShader}`.replace(
				"#include <map_fragment>",
				`#include <map_fragment>
				vec2 sc = scorchAmount();
				// Charcoal, not void: keep a trace of the surface so roofs and walls still read.
				diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.22 + vec3(0.015), sc.x * sc.y);`,
			);
		};
		// A define keeps scorched programs from sharing a cache entry with unpatched ones.
		mat.defines = { ...(mat.defines ?? {}), SCORCH: 1 };
		mat.needsUpdate = true;
	}

	dispose() {
		this.tex.dispose();
	}
}
