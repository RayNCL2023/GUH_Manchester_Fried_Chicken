import type { Vec } from "../../../../shared/types";

// Palette: graphite neutrals, fire orange (primary), flock blue (accent).
export const C = {
	ink: "#0f0f11",
	panel: "#17171a",
	line: "#2a2a2f",
	mute: "#8b8b94",
	text: "#ededed",
	ember: "#e8341c",
	fire: "#ff5a1f",
	amber: "#ffb020",
	glow: "#fff0c0",
	flock: "#5aa9ff",
	water: "#4fd1e8",
	dead: "#4a4a52",
};

export const ART_COLORS: Record<string, string> = {
	".": C.ink,
	r: C.ember,
	o: C.fire,
	y: C.amber,
	w: C.glow,
	b: C.flock,
	t: C.text,
	m: C.mute,
	// Second half of the 4-bit palette, for pictures sent over the sound uplink.
	k: C.dead,
	s: "#f4c7a1",
	n: "#8a5634",
	g: "#4cc26a",
	d: "#1f7a3e",
	p: "#ff8fc0",
	v: "#9b6bff",
	c: "#2b4fd8",
};

export const MODE_COLOR: Record<string, string> = {
	normal: C.flock,
	relay: C.text,
	isolated: C.mute,
	jammed: C.mute,
	down: C.dead,
};

export const agentState = (a: { alive: boolean; jammed: boolean; mode: string }) =>
	!a.alive ? "down" : a.jammed ? "jammed" : a.mode;

// 7×7 drone sprite (x = body, o = core)
export const DRONE = [
	"x.....x",
	".x...x.",
	"..xxx..",
	"..xox..",
	"..xxx..",
	".x...x.",
	"x.....x",
];

export const MARK = [
	"...o...",
	"..oo...",
	"..ooo.o",
	".ooyoo.",
	"ooyyyoo",
	"oyywyyo",
	".ryyyr.",
];

// 3×5 glyphs for sky text
const GLYPHS: Record<string, string[]> = {
	G: ["###", "#..", "#.#", "#.#", "###"],
	U: ["#.#", "#.#", "#.#", "#.#", "###"],
	H: ["#.#", "#.#", "###", "#.#", "#.#"],
	"2": ["###", "..#", "###", "#..", "###"],
	"6": ["###", "#..", "###", "#.#", "###"],
};

function word(text: string, colors: string) {
	return Array.from({ length: 5 }, (_, row) =>
		[...text].map((ch, i) => GLYPHS[ch][row].replace(/#/g, colors[i])).join("."),
	);
}

// Light-show pictures. Each lit pixel becomes one drone's slot.
export const PICTURES = [
	{
		name: "Flame",
		art: [
			"....o....",
			"....oo...",
			"...ooo...",
			"..oooo.o.",
			"..ooyoo..",
			".ooyyyoo.",
			".oyyyyyo.",
			"ooyywyyoo",
			"roywwwyor",
			".royyyor.",
			"..rrrrr..",
		],
	},
	{
		name: "Heart",
		art: [
			".rrr.rrr.",
			"rrrrrrrrr",
			"rrwrrrrrr",
			"rrrrrrrrr",
			".rrrrrrr.",
			"..rrrrr..",
			"...rrr...",
			"....r....",
		],
	},
	{ name: "GUH26", art: word("GUH26", "yyyoo") },
];

function downsampleChars(art: string[], cols: number, rows: number) {
	const h = art.length;
	const w = art[0].length;

	return Array.from({ length: rows }, (_, cy) =>
		Array.from({ length: cols }, (_, cx) => {
			const x0 = Math.floor((cx * w) / cols);
			const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / cols));
			const y0 = Math.floor((cy * h) / rows);
			const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / rows));
			const votes: Record<string, number> = {};

			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const ch = art[y][x];
					votes[ch] = (votes[ch] ?? 0) + (ch === "." ? 0.6 : 1);
				}
			}

			return Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
		}).join(""),
	);
}

const litCount = (art: string[]) => art.join("").replace(/\./g, "").length;

// Largest version of the picture that the remaining drones can still draw.
export function fitArt(art: string[], maxLit: number) {
	for (const s of [1, 0.85, 0.7, 0.6, 0.5, 0.4, 0.3]) {
		const cols = Math.max(2, Math.round(art[0].length * s));
		const rows = Math.max(2, Math.round(art.length * s));
		const out = s === 1 ? art : downsampleChars(art, cols, rows);
		if (litCount(out) <= maxLit) {
			return out;
		}
	}
	return downsampleChars(art, 2, 2);
}

// Compass bearing the wind blows toward (north = up = -y).
export function bearing(v: Vec) {
	const deg = (Math.atan2(v.x, -v.y) * 180) / Math.PI;
	return String(Math.round((deg + 360) % 360)).padStart(3, "0");
}

export const pad = (n: number) => String(n).padStart(2, "0");

export const hash = (x: number, y: number) => ((x * 73856093) ^ (y * 19349663)) >>> 0;

// 16×16 presets for the sound uplink (4 bits a pixel, 136 B with the header).
export const UPLINK_SIZE = 16;
export const BLANK_ART = Array.from({ length: UPLINK_SIZE }, () => ".".repeat(UPLINK_SIZE));
export const UPLINK_PICTURES = [
	{
		name: "Flame",
		art: [
			".......o........",
			".......oo.......",
			"......ooo.......",
			"......oooo...o..",
			".....ooooo..oo..",
			"....oooyooo.oo..",
			"....ooyyyoooooo.",
			"...oooyyyyoooo..",
			"..ooyyyyyyyooo..",
			"..ooyyywyyyyoo..",
			".ooyyywwwyyyyoo.",
			".ooyywwwwwyyyoo.",
			".royywwwwwwyyor.",
			".rooyywwwwyyoor.",
			"..rrooyyyyyoorr.",
			"...rrrrrrrrrrr..",
		],
	},
	{
		name: "Heart",
		art: [
			"................",
			"..rrrr....rrrr..",
			".rrrrrr..rrrrrr.",
			"rrppprrrrrrrrrrr",
			"rrpprrrrrrrrrrrr",
			"rrprrrrrrrrrrrrr",
			"rrrrrrrrrrrrrrrr",
			".rrrrrrrrrrrrrr.",
			"..rrrrrrrrrrrr..",
			"...rrrrrrrrrr...",
			"....rrrrrrrr....",
			".....rrrrrr.....",
			"......rrrr......",
			".......rr.......",
			"................",
			"................",
		],
	},
	{
		name: "Drone",
		art: [
			".mmm........mmm.",
			"mmrmm......mmbmm",
			".mmmk......kmmm.",
			"...kk......kk...",
			"....kk....kk....",
			".....kkkkkk.....",
			".....kcccck.....",
			".....kcbbck.....",
			".....kcbbck.....",
			".....kcccck.....",
			".....kkkkkk.....",
			"....kk....kk....",
			"...kk......kk...",
			".mmmk......kmmm.",
			"mmbmm......mmrmm",
			".mmm........mmm.",
		],
	},
	{
		name: "Tree",
		art: [
			".......gg.......",
			"......gggg......",
			".....ggdggg.....",
			"....gggggdgg....",
			"...ggdgggggggg..",
			"....gggggggg....",
			"...ggggdggggg...",
			"..gggggggggdgg..",
			".ggdgggggggggggg",
			"..gggggggdggg...",
			"...ggggggggg....",
			".......nn.......",
			".......nn.......",
			".......nn.......",
			".....nnnnnn.....",
			"................",
		],
	},
	{
		name: "Smile",
		art: [
			"................",
			".....yyyyyy.....",
			"...yyyyyyyyyy...",
			"..yyyyyyyyyyyy..",
			".yyyykyyyykyyyy.",
			".yyyykyyyykyyyy.",
			"yyyyykyyyykyyyyy",
			"yyyyyyyyyyyyyyyy",
			"yyppyyyyyyyyppyy",
			"yyyykyyyyyykyyyy",
			".yyyykyyyykyyyy.",
			".yyyyykkkkyyyyy.",
			"..yyyyyyyyyyyy..",
			"...yyyyyyyyyy...",
			".....yyyyyy.....",
			"................",
		],
	},
];
