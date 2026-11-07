// Shared 3D frame. Origin = area centre, Y up, X west, Z north (the 3D Tiles ReorientationPlugin's frame).
// Sim cells (x east, y south) and OSM lat/lon both map into it.
import { Object3D, Raycaster, Vector3 } from "three";
import type { LoadedArea } from "../osm";

const M_PER_DEG = 111320;

export class Frame {
	readonly m: number;
	readonly w: number;
	readonly h: number;
	private cosLat: number;

	constructor(readonly area: LoadedArea) {
		this.m = area.mPerCell;
		this.w = area.width;
		this.h = area.height;
		this.cosLat = Math.cos((area.lat * Math.PI) / 180);
	}

	// Continuous cell coords → east/north metres from centre.
	cellEN(x: number, y: number) {
		return { e: (x - this.w / 2) * this.m, n: (this.h / 2 - y) * this.m };
	}

	latLonEN(lat: number, lon: number) {
		return { e: (lon - this.area.lon) * M_PER_DEG * this.cosLat, n: (lat - this.area.lat) * M_PER_DEG };
	}

	world(e: number, n: number, up: number, out = new Vector3()) {
		return out.set(-e, up, n);
	}

	// World point → continuous cell coords.
	cellOf(p: Vector3) {
		return { x: -p.x / this.m + this.w / 2, y: this.h / 2 - p.z / this.m };
	}

	inBounds(e: number, n: number, margin = 0) {
		return Math.abs(e) <= (this.w * this.m) / 2 - margin && Math.abs(n) <= (this.h * this.m) / 2 - margin;
	}
}

const DOWN = new Vector3(0, -1, 0);
const RAY_TOP = 4000;

// Ground height per sim cell, raycast progressively against whatever ground is loaded
// (Google tiles refine over time, so it keeps rescanning while tiles are still arriving).
export class Heightmap {
	readonly heights: Float32Array;
	base = 0;
	// True once a full pass has found ground somewhere.
	ready = false;
	// Completed full passes; lets callers wait for a pass over freshly loaded ground.
	passes = 0;
	private order: number[];
	private cursor = 0;
	private dirty = false;
	private ray = new Raycaster();
	private origin = new Vector3();

	constructor(
		private frame: Frame,
		private target: Object3D,
	) {
		this.heights = new Float32Array(frame.w * frame.h).fill(NaN);
		this.ray.far = RAY_TOP * 2;
		(this.ray as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;

		// Coarse-to-fine: every 8th cell first, so the whole map has a rough height quickly.
		const seen = new Set<number>();
		this.order = [];
		for (const stride of [8, 4, 2, 1]) {
			for (let y = 0; y < frame.h; y += stride) {
				for (let x = 0; x < frame.w; x += stride) {
					const i = y * frame.w + x;
					if (!seen.has(i)) {
						seen.add(i);
						this.order.push(i);
					}
				}
			}
		}
	}

	setTarget(target: Object3D) {
		this.target = target;
		this.heights.fill(NaN);
		this.cursor = 0;
		this.ready = false;
	}

	// Call when new ground geometry arrived.
	invalidate() {
		this.dirty = true;
	}

	castAt(e: number, n: number): number | null {
		this.frame.world(e, n, RAY_TOP, this.origin);
		this.ray.set(this.origin, DOWN);
		const hit = this.ray.intersectObject(this.target, true)[0];
		return hit ? hit.point.y : null;
	}

	step(budget: number) {
		if (this.cursor >= this.order.length) {
			if (!this.dirty) {
				return;
			}
			this.dirty = false;
			this.cursor = 0;
		}
		const { w } = this.frame;
		const end = Math.min(this.order.length, this.cursor + budget);
		for (; this.cursor < end; this.cursor++) {
			const i = this.order[this.cursor];
			const { e, n } = this.frame.cellEN((i % w) + 0.5, Math.floor(i / w) + 0.5);
			const y = this.castAt(e, n);
			if (y !== null) {
				this.heights[i] = y;
			}
		}
		if (this.cursor === this.order.length) {
			this.base = median(this.heights);
			this.passes++;
			this.ready ||= this.heights.some((v) => !Number.isNaN(v));
		}
	}

	// Height of a cell; unknown cells borrow the coarse sample they belong to.
	at(x: number, y: number) {
		const { w, h } = this.frame;
		const cx = Math.max(0, Math.min(w - 1, Math.floor(x)));
		const cy = Math.max(0, Math.min(h - 1, Math.floor(y)));
		const v = this.heights[cy * w + cx];
		if (!Number.isNaN(v)) {
			return v;
		}
		const coarse = this.heights[(cy - (cy % 8)) * w + (cx - (cx % 8))];
		return Number.isNaN(coarse) ? this.base : coarse;
	}

	// Lowest point around a cell: roads sit lower than trees and roofs next to them.
	minNear(x: number, y: number, r = 1) {
		let best = Infinity;
		for (let dy = -r; dy <= r; dy++) {
			for (let dx = -r; dx <= r; dx++) {
				best = Math.min(best, this.at(x + dx, y + dy));
			}
		}
		return best;
	}

	maxNear(x: number, y: number, r = 2) {
		let best = -Infinity;
		for (let dy = -r; dy <= r; dy++) {
			for (let dx = -r; dx <= r; dx++) {
				best = Math.max(best, this.at(x + dx, y + dy));
			}
		}
		return best;
	}
}

function median(a: Float32Array) {
	const v = Array.from(a).filter((x) => !Number.isNaN(x));
	if (!v.length) {
		return 0;
	}
	v.sort((p, q) => p - q);
	return v[Math.floor(v.length / 2)];
}
