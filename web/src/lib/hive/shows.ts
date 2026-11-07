// Flock show choreography. A show is a formation plus a motion over time.
// Every drone can compute it from (show, start tick, shared clock), so a drone that loses
// its radio keeps dancing in sync from its last orders instead of freezing.
import type { Vec } from "../../../../shared/types";
import { ART_COLORS, C, PICTURES, fitArt, hash } from "./pixel";

export const CENTRE: Vec = { x: 48, y: 22 };

export type Slot = { base: Vec; color: string; ring: number; u: number };
export type Layout = { slots: Slot[]; size: string };

export type Show = {
	name: string;
	thumb: string[];
	layout: (n: number) => Layout;
	move: (s: Slot, t: number) => Vec;
	tint?: (s: Slot, i: number, t: number) => string;
};

const mix = (a: string, b: string, k: number) => {
	const pa = parseInt(a.slice(1), 16);
	const pb = parseInt(b.slice(1), 16);
	const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - k) + ((pb >> s) & 255) * k);
	return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
};

const rotate = (p: Vec, a: number): Vec => {
	const dx = p.x - CENTRE.x;
	const dy = p.y - CENTRE.y;
	return { x: CENTRE.x + dx * Math.cos(a) - dy * Math.sin(a), y: CENTRE.y + dx * Math.sin(a) + dy * Math.cos(a) };
};

// Pixel picture around the centre, shrunk to however many drones are left.
function picture(art: string[]) {
	return (n: number): Layout => {
		const fit = fitArt(art, n);
		const w = fit[0].length;
		const h = fit.length;
		const s = Math.min(4.2, 66 / w, 30 / h);
		const slots: Slot[] = [];
		fit.forEach((row, y) =>
			[...row].forEach((ch, x) => {
				if (ch === ".") {
					return;
				}
				slots.push({
					base: { x: CENTRE.x + (x - (w - 1) / 2) * s, y: CENTRE.y + (y - (h - 1) / 2) * s },
					color: ART_COLORS[ch],
					ring: 0,
					u: y / Math.max(1, h - 1),
				});
			}),
		);
		return { slots, size: `${w}×${h}` };
	};
}

const [FLAME, HEART, GUH] = PICTURES;

export const SHOWS: Show[] = [
	{
		name: "Flame",
		thumb: FLAME.art,
		layout: picture(FLAME.art),
		// Tips sway more than the base.
		move: (s, t) => ({ x: s.base.x + Math.sin(t * 3 + s.base.y * 0.35) * (1.6 - s.u * 1.3), y: s.base.y + Math.sin(t * 2.2 + s.base.x) * 0.4 }),
		tint: (s, i, t) => (hash(i, Math.floor(t * 5)) % 9 === 0 ? C.glow : s.color),
	},
	{
		name: "Heartbeat",
		thumb: HEART.art,
		layout: picture(HEART.art),
		move: (s, t) => {
			const beat = Math.pow(Math.max(0, Math.sin((t * Math.PI * 2) / 1.2)), 4);
			const k = 1 + 0.1 * beat;
			return { x: CENTRE.x + (s.base.x - CENTRE.x) * k, y: CENTRE.y + (s.base.y - CENTRE.y) * k };
		},
	},
	{
		name: "Hive",
		thumb: ["..ooo..", ".o.y.o.", "o.yyy.o", "oyywyyo", "o.yyy.o", ".o.y.o.", "..ooo.."],
		// Hexagon rings around a bright core; alternate rings turn opposite ways.
		layout: (n) => {
			const slots: Slot[] = [{ base: CENTRE, color: C.glow, ring: 0, u: 0 }];
			const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]; // walk each ring, starting at (-r, r)
			for (let r = 1; slots.length < n && r <= 6; r++) {
				let q = -r;
				let k = r;
				for (const [dq, dk] of dirs) {
					for (let step = 0; step < r && slots.length < n; step++) {
						const x = 3.4 * (q + k / 2);
						const y = 3.4 * (k * 0.866);
						slots.push({ base: { x: CENTRE.x + x, y: CENTRE.y + y }, color: r % 2 ? C.fire : C.amber, ring: r, u: r / 6 });
						q += dq;
						k += dk;
					}
				}
			}
			return { slots, size: `${slots.length} cells` };
		},
		move: (s, t) => rotate(s.base, t * 0.22 * (s.ring % 2 ? 1 : -1)),
	},
	{
		name: "Spiral",
		thumb: ["...bb..", ".b...t.", "b..t..t", "b.tbt.b", "t..t..b", ".t...b.", "..bb..."],
		layout: (n) => {
			const per = Math.ceil(n / 3);
			const slots: Slot[] = Array.from({ length: n }, (_, i) => {
				const arm = i % 3;
				const k = Math.floor(i / 3) / Math.max(1, per - 1);
				const r = 2 + k * 16;
				const a = (arm * Math.PI * 2) / 3 + k * 4.2;
				return {
					base: { x: CENTRE.x + Math.cos(a) * r * 1.5, y: CENTRE.y + Math.sin(a) * r },
					color: k < 0.3 ? C.text : k < 0.7 ? C.flock : C.amber,
					ring: 0,
					u: k,
				};
			});
			return { slots, size: "3 arms" };
		},
		move: (s, t) => {
			const a = t * 0.3;
			const dx = (s.base.x - CENTRE.x) / 1.5;
			const dy = s.base.y - CENTRE.y;
			const breathe = 1 + 0.06 * Math.sin(t * 1.3);
			return {
				x: CENTRE.x + (dx * Math.cos(a) - dy * Math.sin(a)) * 1.5 * breathe,
				y: CENTRE.y + (dx * Math.sin(a) + dy * Math.cos(a)) * breathe,
			};
		},
	},
	{
		name: "Murmuration",
		thumb: ["b......", ".bb...t", "...b.t.", "....t..", "......."],
		// A ribbon that flows like starlings.
		layout: (n) => ({
			slots: Array.from({ length: n }, (_, i) => {
				const u = i / Math.max(1, n - 1);
				return { base: { x: CENTRE.x + (u - 0.5) * 72, y: CENTRE.y }, color: mix(C.flock, C.text, u), ring: 0, u };
			}),
			size: "ribbon",
		}),
		move: (s, t) => ({
			x: s.base.x + Math.sin(t * 0.9 + s.u * 4) * 3,
			y: CENTRE.y + Math.sin(t * 0.9 + s.u * 6) * 6 + Math.sin(t * 0.5 + s.u * 13) * 2.5,
		}),
	},
	{
		name: "GUH26",
		thumb: GUH.art,
		layout: picture(GUH.art),
		move: (s, t) => ({ x: s.base.x, y: s.base.y + Math.sin(t * 2.4 - s.base.x * 0.22) * 1.6 }),
	},
];
