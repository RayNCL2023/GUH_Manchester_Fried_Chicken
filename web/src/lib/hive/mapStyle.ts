// How the OSM terrain is drawn: colour, edge lighting, shadows, water depth.
// Light comes from the top-left; the fire is the only thing that glows.
import { T } from "./osm";
import { hash } from "./pixel";

export const STYLE = {
	ground: ["#2a2b30", "#2d2e33", "#28292e"],
	urban: ["#34353c", "#323339"],
	grass: ["#2f6b3c", "#347443", "#2c6438"],
	wood: ["#1f5230", "#235b35", "#1c4a2b"],
	canopy: "#3f8a4c",
	water: ["#3a8fc9", "#2c78b3", "#21639c", "#1a5287", "#164574"], // shore → deep
	sparkle: "#b8e4ff",
	path: "#8a7a4e",
	road: "#d9b84f",
	major: "#f5d266",
	roofs: ["#d8cfbf", "#c8775c", "#9aa8bf", "#b89a78", "#e3ddd0", "#8f9e93", "#cf9a6a"],
	burnt: ["#2c211c", "#33251e", "#3e2418"],
	burntBuilding: "#4d2b1f",
};

export const LEGEND_COLORS = {
	buildings: STYLE.roofs[1],
	roads: STYLE.major,
	water: STYLE.water[1],
	green: STYLE.grass[1],
};

// Lighten (amt > 0) or darken (amt < 0) a hex colour.
export function shade(hex: string, amt: number) {
	const n = parseInt(hex.slice(1), 16);
	const mix = (c: number) => Math.round(amt > 0 ? c + (255 - c) * amt : c * (1 + amt));
	const r = mix(n >> 16);
	const g = mix((n >> 8) & 255);
	const b = mix(n & 255);
	return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// Label connected buildings so each one gets a single roof colour.
function buildingIds(terrain: Uint8Array, w: number, h: number) {
	const ids = new Int32Array(terrain.length).fill(-1);
	let next = 0;
	for (let i = 0; i < terrain.length; i++) {
		if (terrain[i] !== T.building || ids[i] !== -1) {
			continue;
		}
		const stack = [i];
		ids[i] = next;
		while (stack.length) {
			const j = stack.pop()!;
			const x = j % w;
			const y = (j / w) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx;
				const ny = y + dy;
				const k = ny * w + nx;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h || terrain[k] !== T.building || ids[k] !== -1) {
					continue;
				}
				ids[k] = next;
				stack.push(k);
			}
		}
		next++;
	}
	return ids;
}

// Distance (in cells) from the shore, so open water gets deeper.
function waterDepth(terrain: Uint8Array, w: number, h: number) {
	const depth = new Int16Array(terrain.length).fill(-1);
	let queue: number[] = [];
	for (let i = 0; i < terrain.length; i++) {
		if (terrain[i] !== T.water) {
			depth[i] = 0;
			queue.push(i);
		}
	}
	while (queue.length) {
		const next: number[] = [];
		for (const j of queue) {
			const x = j % w;
			const y = (j / w) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx;
				const ny = y + dy;
				const k = ny * w + nx;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h || depth[k] !== -1) {
					continue;
				}
				depth[k] = depth[j] + 1;
				next.push(k);
			}
		}
		queue = next;
	}
	return depth;
}

type Dot = (x: number, y: number, color: string) => void;

export function paintTerrain(ctx: CanvasRenderingContext2D, terrain: Uint8Array, w: number, h: number, cell: number, dot: Dot) {
	const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : terrain[y * w + x]);
	const ids = buildingIds(terrain, w, h);
	const depth = waterDepth(terrain, w, h);
	const pick = (list: string[], x: number, y: number) => list[hash(x, y) % list.length];

	ctx.fillStyle = "#1c1d21";
	ctx.fillRect(0, 0, w * cell, h * cell);

	for (let i = 0; i < terrain.length; i++) {
		const x = i % w;
		const y = (i / w) | 0;
		const t = terrain[i];

		if (t === T.building) {
			const roof = STYLE.roofs[hash(ids[i], 11) % STYLE.roofs.length];
			const lit = at(x, y - 1) !== T.building || at(x - 1, y) !== T.building;
			const dark = at(x, y + 1) !== T.building || at(x + 1, y) !== T.building;
			dot(x, y, lit && !dark ? shade(roof, 0.22) : dark && !lit ? shade(roof, -0.28) : roof);
			continue;
		}

		let color: string;
		if (t === T.water) {
			color = STYLE.water[Math.min(STYLE.water.length - 1, depth[i] - 1)];
		} else if (t === T.major || t === T.road) {
			const base = t === T.major ? STYLE.major : STYLE.road;
			const edge = [at(x, y - 1), at(x, y + 1), at(x - 1, y), at(x + 1, y)].some((n) => n !== T.major && n !== T.road);
			color = edge ? shade(base, -0.18) : base;
		} else if (t === T.path) {
			color = STYLE.path;
		} else if (t === T.wood) {
			color = hash(x, y) % 5 === 0 ? STYLE.canopy : pick(STYLE.wood, x, y);
		} else if (t === T.grass) {
			color = pick(STYLE.grass, x, y);
		} else if (t === T.urban) {
			color = pick(STYLE.urban, x, y);
		} else {
			color = pick(STYLE.ground, x, y);
		}

		// Buildings cast a short shadow down and to the right.
		if (at(x - 1, y - 1) === T.building || at(x - 1, y) === T.building || at(x, y - 1) === T.building) {
			color = shade(color, -0.35);
		}
		dot(x, y, color);
	}

	// Soft light from the top-left, falling off to the far corner.
	const light = ctx.createLinearGradient(0, 0, w * cell, h * cell);
	light.addColorStop(0, "rgba(255,244,220,.10)");
	light.addColorStop(0.55, "rgba(255,244,220,0)");
	light.addColorStop(1, "rgba(5,8,20,.28)");
	ctx.fillStyle = light;
	ctx.fillRect(0, 0, w * cell, h * cell);
}

// Water cells, for the per-tick sparkle.
export const waterCells = (terrain: Uint8Array) => terrain.reduce<number[]>((acc, t, i) => (t === T.water ? (acc.push(i), acc) : acc), []);
