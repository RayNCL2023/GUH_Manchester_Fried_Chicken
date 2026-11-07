// Satellite imagery under the fire grid. Esri World Imagery tiles (no key; attribution shown in the UI).
// Presets are pre-baked into /public/sat so the demo works offline.
import { GRID, PRESETS, bbox, type Area } from "./osm";

export const SAT_ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";
const TILE = 256;

// Web Mercator pixel coordinates at zoom z.
const worldX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const worldY = (lat: number, z: number) => {
	const r = (lat * Math.PI) / 180;
	return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

// Zoom whose ground resolution matches the canvas (cellPx canvas pixels per grid cell).
export function zoomFor(a: Area, cellPx: number) {
	const metresPerPx = a.mPerCell / cellPx;
	const z = Math.log2((156543.03 * Math.cos((a.lat * Math.PI) / 180)) / metresPerPx);
	return Math.max(12, Math.min(18, Math.round(z)));
}

export function tilesFor(a: Area, z: number) {
	const { s, w, n, e } = bbox(a);
	const x0 = Math.floor(worldX(w, z) / TILE);
	const x1 = Math.floor(worldX(e, z) / TILE);
	const y0 = Math.floor(worldY(n, z) / TILE);
	const y1 = Math.floor(worldY(s, z) / TILE);
	const tiles: { x: number; y: number }[] = [];
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			tiles.push({ x, y });
		}
	}
	return tiles;
}

export const tileUrl = (z: number, x: number, y: number) => `${ESRI}/${z}/${y}/${x}`;
const bakedUrl = (a: Area, z: number, x: number, y: number) => `/sat/${a.id}/${z}/${x}/${y}.jpg`;

function loadImage(src: string) {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}

// Stitch the tiles covering the area into one canvas the size of the fire map.
export async function loadSatellite(a: Area, cellPx: number): Promise<HTMLCanvasElement> {
	const z = zoomFor(a, cellPx);
	const { s, w, n, e } = bbox(a);
	const width = GRID.w * cellPx;
	const height = GRID.h * cellPx;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d")!;

	const left = worldX(w, z);
	const top = worldY(n, z);
	const sx = width / (worldX(e, z) - left);
	const sy = height / (worldY(s, z) - top);
	const baked = PRESETS.some((p) => p.id === a.id);

	await Promise.all(
		tilesFor(a, z).map(async ({ x, y }) => {
			const img = await loadImage(baked ? bakedUrl(a, z, x, y) : tileUrl(z, x, y)).catch(() =>
				baked ? loadImage(tileUrl(z, x, y)) : null,
			);
			if (!img) {
				return;
			}
			ctx.drawImage(img, (x * TILE - left) * sx, (y * TILE - top) * sy, TILE * sx + 1, TILE * sy + 1);
		}),
	);

	return canvas;
}
