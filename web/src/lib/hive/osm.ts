// OpenStreetMap → pixel terrain. Overpass for features, Nominatim for place search.
// Presets are pre-baked into /public/osm so the demo works on bad venue wifi.
import type { Vec } from "../../../../shared/types";

// Same ground area as the first 96×60 version, at 1.5× the resolution.
export const GRID = { w: 144, h: 90 };

export type Area = { id: string; name: string; lat: number; lon: number; mPerCell: number };
export type OsmElement = { type: string; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] };
export type OsmData = { elements: OsmElement[] };
export type LoadedArea = Area & { terrain: Uint8Array; width: number; height: number; counts: Record<string, number>; osm: OsmData };

export const PRESETS: Area[] = [
	{ id: "diggle", name: "Diggle, Saddleworth", lat: 53.5655, lon: -1.9925, mPerCell: 20 / 3 },
	{ id: "dovestone", name: "Dovestone Reservoir", lat: 53.531, lon: -1.973, mPerCell: 32 / 3 },
	{ id: "campus", name: "University of Manchester", lat: 53.4668, lon: -2.2325, mPerCell: 16 / 3 },
];

// Terrain codes, painted in this order (later wins).
export const T = { ground: 0, urban: 1, grass: 2, wood: 3, water: 4, path: 5, road: 6, major: 7, building: 8 } as const;

// Chance a cell actually catches when the fire tries to spread into it.
export const FUEL: Record<number, number> = {
	[T.ground]: 0.75,
	[T.urban]: 0.35,
	[T.grass]: 1,
	[T.wood]: 0.9,
	[T.water]: 0,
	[T.path]: 0.6,
	[T.road]: 0.06,
	[T.major]: 0.02,
	[T.building]: 0.6,
};

const OVERPASS = "https://overpass-api.de/api/interpreter";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// oneway/junction drive the 3D traffic; height/levels extrude 3D buildings.
const KEEP_TAGS = ["building", "highway", "natural", "landuse", "leisure", "waterway", "water", "amenity", "oneway", "junction", "height", "building:levels"];

export function bbox(a: Area) {
	const halfW = (GRID.w * a.mPerCell) / 2;
	const halfH = (GRID.h * a.mPerCell) / 2;
	const dLat = halfH / 111320;
	const dLon = halfW / (111320 * Math.cos((a.lat * Math.PI) / 180));
	return { s: a.lat - dLat, w: a.lon - dLon, n: a.lat + dLat, e: a.lon + dLon };
}

export function overpassQuery(a: Area) {
	const { s, w, n, e } = bbox(a);
	const b = `(${s},${w},${n},${e})`;
	return `[out:json][timeout:25];(
way["building"]${b};
way["highway"]${b};
way["waterway"]${b};
way["natural"]${b};
way["landuse"]${b};
way["leisure"]${b};
way["amenity"="parking"]${b};
);out geom;`;
}

// Strip Overpass output to what the rasteriser needs.
export function slim(data: OsmData): OsmData {
	return {
		elements: data.elements
			.filter((el) => el.geometry?.length)
			.map((el) => ({
				type: el.type,
				tags: Object.fromEntries(Object.entries(el.tags ?? {}).filter(([k]) => KEEP_TAGS.includes(k))),
				geometry: el.geometry!.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })),
			})),
	};
}

export async function fetchOverpass(a: Area): Promise<OsmData> {
	const res = await fetch(OVERPASS, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `data=${encodeURIComponent(overpassQuery(a))}`,
	});
	if (!res.ok) {
		throw new Error(`Overpass ${res.status}`);
	}
	return slim(await res.json());
}

export async function geocode(q: string): Promise<Area | null> {
	const res = await fetch(`${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`);
	if (!res.ok) {
		throw new Error(`Nominatim ${res.status}`);
	}
	const [hit] = (await res.json()) as { lat: string; lon: string; display_name: string }[];
	if (!hit) {
		return null;
	}
	const lat = Number(hit.lat);
	const lon = Number(hit.lon);
	return { id: `${lat.toFixed(4)},${lon.toFixed(4)}`, name: hit.display_name.split(",")[0], lat, lon, mPerCell: 7 };
}

// Baked preset → localStorage cache → live Overpass.
export async function loadArea(a: Area): Promise<LoadedArea> {
	const key = `hive:osm:${a.id}:${a.mPerCell}`;
	let data: OsmData | null = null;

	if (PRESETS.some((p) => p.id === a.id)) {
		const res = await fetch(`/osm/${a.id}.json`);
		data = res.ok ? await res.json() : null;
	}
	if (!data) {
		const cached = localStorage.getItem(key);
		data = cached ? JSON.parse(cached) : null;
	}
	if (!data) {
		data = await fetchOverpass(a);
		try {
			localStorage.setItem(key, JSON.stringify(data));
		} catch {
			// Cache full: fine, we just refetch next time.
		}
	}

	return { ...a, ...rasterize(data, a), width: GRID.w, height: GRID.h, osm: data };
}

// ---------- rasteriser ----------

type Layer = { code: number; poly?: Vec[]; line?: Vec[]; widthM?: number };

const AREA_RULES: [code: number, test: (t: Record<string, string>) => boolean][] = [
	[T.building, (t) => !!t.building],
	[T.water, (t) => t.natural === "water" || !!t.water || ["reservoir", "basin"].includes(t.landuse)],
	[T.wood, (t) => t.natural === "wood" || t.landuse === "forest"],
	[
		T.grass,
		(t) =>
			["heath", "moor", "scrub", "grassland", "fell"].includes(t.natural) ||
			["grass", "meadow", "farmland", "recreation_ground", "village_green"].includes(t.landuse) ||
			["park", "garden", "pitch", "golf_course"].includes(t.leisure),
	],
	[T.urban, (t) => ["residential", "commercial", "industrial", "retail", "construction"].includes(t.landuse) || t.amenity === "parking"],
];

const ROAD_RULES: [code: number, widthM: number, test: (t: Record<string, string>) => boolean][] = [
	[T.water, 10, (t) => ["river", "canal"].includes(t.waterway)],
	[T.water, 3, (t) => ["stream", "drain", "ditch"].includes(t.waterway)],
	[T.major, 14, (t) => ["motorway", "trunk", "primary", "secondary"].includes(t.highway?.replace("_link", ""))],
	[T.road, 9, (t) => ["tertiary", "residential", "unclassified", "service", "living_street"].includes(t.highway)],
	[T.path, 3, (t) => ["footway", "path", "track", "cycleway", "bridleway", "pedestrian", "steps"].includes(t.highway)],
];

const PAINT_ORDER = [T.urban, T.grass, T.wood, T.water, T.path, T.road, T.major, T.building];

function fillPoly(pts: Vec[], w: number, h: number, set: (i: number) => void) {
	const ys = pts.map((p) => p.y);
	let hit = false;

	for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y++) {
		const yc = y + 0.5;
		const xs: number[] = [];
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i];
			const b = pts[(i + 1) % pts.length];
			if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
				xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
			}
		}
		xs.sort((p, q) => p - q);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) {
				set(y * w + x);
				hit = true;
			}
		}
	}

	if (hit) {
		return;
	}
	// Smaller than a cell: still mark its centre so small buildings show up.
	const cx = Math.floor(pts.reduce((s, p) => s + p.x, 0) / pts.length);
	const cy = Math.floor(ys.reduce((s, y) => s + y, 0) / pts.length);
	if (cx >= 0 && cy >= 0 && cx < w && cy < h) {
		set(cy * w + cx);
	}
}

function strokeLine(pts: Vec[], radius: number, w: number, h: number, set: (i: number) => void) {
	for (let i = 0; i + 1 < pts.length; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.3));
		for (let s = 0; s <= steps; s++) {
			const px = a.x + ((b.x - a.x) * s) / steps;
			const py = a.y + ((b.y - a.y) * s) / steps;
			const r = Math.ceil(radius);
			for (let dy = -r; dy <= r; dy++) {
				for (let dx = -r; dx <= r; dx++) {
					const x = Math.floor(px + dx);
					const y = Math.floor(py + dy);
					if (x < 0 || y < 0 || x >= w || y >= h || Math.hypot(x + 0.5 - px, y + 0.5 - py) > radius) {
						continue;
					}
					set(y * w + x);
				}
			}
		}
	}
}

export function rasterize(data: OsmData, a: Area) {
	const { w, h } = GRID;
	const { s, w: west, n, e } = bbox(a);
	const project = (p: { lat: number; lon: number }): Vec => ({
		x: ((p.lon - west) / (e - west)) * w,
		y: ((n - p.lat) / (n - s)) * h,
	});

	const layers: Layer[] = [];
	for (const el of data.elements) {
		const tags = el.tags ?? {};
		const pts = el.geometry!.map(project);
		const road = ROAD_RULES.find(([, , test]) => test(tags));
		if (road) {
			layers.push({ code: road[0], line: pts, widthM: road[1] });
			continue;
		}
		const area = AREA_RULES.find(([, test]) => test(tags));
		if (area && pts.length >= 3) {
			layers.push({ code: area[0], poly: pts });
		}
	}

	const terrain = new Uint8Array(w * h).fill(T.ground);
	for (const code of PAINT_ORDER) {
		for (const l of layers) {
			if (l.code !== code) {
				continue;
			}
			const set = (i: number) => (terrain[i] = code);
			if (l.poly) {
				fillPoly(l.poly, w, h, set);
			} else if (l.line) {
				strokeLine(l.line, Math.max(0.5, l.widthM! / a.mPerCell / 2), w, h, set);
			}
		}
	}

	const counts = {
		buildings: data.elements.filter((el) => el.tags?.building).length,
		roads: data.elements.filter((el) => el.tags?.highway).length,
	};
	return { terrain, counts };
}
