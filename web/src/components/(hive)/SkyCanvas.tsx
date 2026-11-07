"use client";

import { useEffect, useRef } from "react";
import { twMerge } from "tailwind-merge";
import type { Vec } from "../../../../shared/types";
import { C, hash } from "@/lib/hive/pixel";
import { SKY_H, SKY_W, STATION, type SkySnap } from "@/lib/hive/skyLive";
import { drawJam, lerpPos, useCanvasLoop, usePointerJam } from "./canvasKit";

const CELL = 12;
const W = SKY_W * CELL;
const H = SKY_H * CELL;
const DOT = 6; // scene dot pitch
const SKY = ["#06080e", "#090c15", "#0c111d", "#111727", "#161d30"];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

type Star = { x: number; y: number; r: number; phase: number };

const circle = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string, a = 1) => {
	ctx.globalAlpha = a;
	ctx.fillStyle = c;
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.fill();
	ctx.globalAlpha = 1;
};

// Night scene in soft dots: dithered sky, moon, hills, skyline with lit windows. Painted once.
function paintScene(ctx: CanvasRenderingContext2D) {
	const cols = W / DOT;
	const rows = H / DOT;

	ctx.fillStyle = SKY[0];
	ctx.fillRect(0, 0, W, H);
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			const t = (y / rows) * (SKY.length - 1);
			const band = Math.floor(t);
			const up = (t - band) * 16 > BAYER[(y % 4) * 4 + (x % 4)];
			ctx.fillStyle = SKY[Math.min(SKY.length - 1, band + (up ? 1 : 0))];
			ctx.beginPath();
			ctx.roundRect(x * DOT + 0.5, y * DOT + 0.5, DOT - 1, DOT - 1, 2.2);
			ctx.fill();
		}
	}

	const moon = { x: W * 0.86, y: H * 0.17, r: 34 };
	circle(ctx, moon.x, moon.y, moon.r + 18, "#e9e4d8", 0.05);
	circle(ctx, moon.x, moon.y, moon.r, "#e9e4d8");
	circle(ctx, moon.x + 10, moon.y + 8, moon.r * 0.82, "#cfc9ba", 0.55);
	for (const [dx, dy, r] of [[-10, -8, 5], [8, -14, 3], [4, 10, 4], [-14, 9, 3]]) {
		circle(ctx, moon.x + dx, moon.y + dy, r, "#bdb7a8", 0.8);
	}

	ctx.fillStyle = "#121827";
	ctx.beginPath();
	ctx.moveTo(0, H);
	for (let x = 0; x <= W; x += 8) {
		ctx.lineTo(x, H - 150 + Math.sin(x / 120) * 18 + Math.sin(x / 47 + 1) * 8);
	}
	ctx.lineTo(W, H);
	ctx.fill();

	let x = 0;
	let seed = 1;
	while (x < W) {
		seed = (seed * 9301 + 49297) % 233280;
		const r = seed / 233280;
		const bw = 36 + Math.floor(r * 60);
		const tower = x > 720 && x < 800;
		const bh = tower ? 270 : 42 + Math.floor(((r * 997) % 1) * 96);
		const top = H - bh;

		ctx.fillStyle = "#0a0d15";
		ctx.beginPath();
		ctx.roundRect(x, top, bw, bh + 10, [8, 8, 0, 0]);
		ctx.fill();

		for (let wy = top + 10; wy < H - 6; wy += 12) {
			for (let wx = x + 9; wx < x + bw - 6; wx += 12) {
				if (hash(wx, wy) % 5 !== 0) {
					continue;
				}
				circle(ctx, wx, wy, 2.4, hash(wy, wx) % 3 ? C.amber : "#e9e4d8", 0.65);
			}
		}
		if (tower) {
			circle(ctx, x + bw / 2, top - 6, 3.5, C.ember);
		}
		x += bw + (r > 0.7 ? 6 : 0);
	}
}

// Ground station: the only place new shows come from. Pulses while it transmits.
function drawStation(ctx: CanvasRenderingContext2D, transmitting: boolean, now: number) {
	const x = (STATION.x + 0.5) * CELL;
	const y = (STATION.y + 0.5) * CELL;
	if (transmitting) {
		for (let k = 0; k < 3; k++) {
			const r = ((now / 8 + k * 60) % 180) + 6;
			ctx.strokeStyle = `rgba(90,169,255,${0.5 * (1 - r / 186)})`;
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(x, y - 14, r, Math.PI, Math.PI * 2);
			ctx.stroke();
		}
	}
	ctx.fillStyle = "#2c3242";
	ctx.beginPath();
	ctx.roundRect(x - 3, y - 14, 6, 20, 3);
	ctx.fill();
	circle(ctx, x, y - 16, 4.5, transmitting ? C.flock : "#5a6274");
}

function makeStars(): Star[] {
	return Array.from({ length: 140 }, (_, i) => ({
		x: hash(i, 7) % W,
		y: hash(7, i) % Math.floor(H * 0.6),
		r: 0.8 + (hash(i, i) % 3) * 0.6,
		phase: (hash(i, 3) % 100) / 16,
	}));
}

function drawDrone(ctx: CanvasRenderingContext2D, d: SkySnap["drones"][number], p: Vec, now: number) {
	const cx = (p.x + 0.5) * CELL;
	const cy = (p.y + 0.5) * CELL;
	const lit = d.alive && d.color !== "#000000";

	if (!d.alive) {
		circle(ctx, cx, cy, 2.5, C.dead);
		return;
	}

	if (!lit) {
		circle(ctx, cx, cy, 4, "#2c3242");
		const blink = Math.floor(now / 500 + p.x) % 2 === 0;
		circle(ctx, cx, cy, 1.6, blink ? C.ember : "#3fdc7e");
		return;
	}

	if (d.fresh) {
		ctx.strokeStyle = "rgba(255,255,255,.7)";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(cx, cy, 9 + (now % 600) / 40, 0, Math.PI * 2);
		ctx.stroke();
	}
	if (d.stale) {
		ctx.strokeStyle = "rgba(139,139,148,.8)";
		ctx.lineWidth = 1.5;
		ctx.setLineDash([2, 3]);
		ctx.beginPath();
		ctx.arc(cx, cy, 8, 0, Math.PI * 2);
		ctx.stroke();
		ctx.setLineDash([]);
	}

	const f = d.jammed ? 0.55 + Math.random() * 0.35 : 1;
	circle(ctx, cx, cy, 16, d.color, 0.08 * f);
	circle(ctx, cx, cy, 10, d.color, 0.2 * f);
	circle(ctx, cx, cy, 5.5, d.color, f);
	circle(ctx, cx, cy, 2, "#ffffff", f);
	if (d.jammed && Math.random() < 0.4) {
		circle(ctx, cx + (Math.random() - 0.5) * 8, cy + (Math.random() - 0.5) * 8, 1.5, C.mute);
	}
}

export default function ({
	snap,
	onKill,
	onJam,
	className,
}: {
	snap: SkySnap;
	onKill?: (id: string) => void;
	onJam?: (center: Vec, radius: number) => void;
	className?: string;
}) {
	const scene = useRef<HTMLCanvasElement | null>(null);
	const stars = useRef<Star[]>([]);
	const prev = useRef(new Map<string, Vec>());
	const curr = useRef(snap);
	const changedAt = useRef(0);

	useEffect(() => {
		scene.current = document.createElement("canvas");
		scene.current.width = W;
		scene.current.height = H;
		paintScene(scene.current.getContext("2d")!);
		stars.current = makeStars();
	}, []);

	useEffect(() => {
		prev.current = new Map(curr.current.drones.map((d) => [d.id, d.pos]));
		curr.current = snap;
		changedAt.current = performance.now();
	}, [snap]);

	const pointer = usePointerJam({
		size: { w: SKY_W, h: SKY_H },
		hitTest: (p) =>
			curr.current.drones.find((d) => d.alive && Math.hypot(d.pos.x + 0.5 - p.x, d.pos.y + 0.5 - p.y) < 1.6)?.id,
		onHit: (id) => onKill?.(id),
		onJam,
	});

	const ref = useCanvasLoop((ctx, now) => {
		const s = curr.current;
		if (!scene.current) {
			return;
		}

		ctx.drawImage(scene.current, 0, 0);
		for (const st of stars.current) {
			circle(ctx, st.x, st.y, st.r, "#e9e4d8", 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(now / 700 + st.phase)));
		}

		for (const j of s.jams) {
			drawJam(ctx, j.center, j.radius, CELL);
		}
		const drag = pointer.drag.current;
		if (drag) {
			drawJam(ctx, drag.start, Math.hypot(drag.now.x - drag.start.x, drag.now.y - drag.start.y), CELL);
		}

		drawStation(ctx, s.transmitting, now);

		for (const t of s.targets) {
			circle(ctx, (t.pos.x + 0.5) * CELL, (t.pos.y + 0.5) * CELL, 1.6, t.color, 0.3);
		}

		ctx.lineWidth = 1;
		ctx.strokeStyle = "rgba(90,169,255,.1)";
		for (const [a, b] of s.links) {
			ctx.beginPath();
			ctx.moveTo((a.x + 0.5) * CELL, (a.y + 0.5) * CELL);
			ctx.lineTo((b.x + 0.5) * CELL, (b.y + 0.5) * CELL);
			ctx.stroke();
		}

		const t = Math.min(1, (now - changedAt.current) / 100);
		for (const d of s.drones) {
			drawDrone(ctx, d, lerpPos(prev.current.get(d.id), d.pos, t), now);
		}
	});

	return (
		<canvas
			ref={ref}
			width={W}
			height={H}
			{...pointer.handlers}
			className={twMerge("block max-w-full h-auto rounded-[1rem] cursor-crosshair touch-none", className)}
		/>
	);
}
