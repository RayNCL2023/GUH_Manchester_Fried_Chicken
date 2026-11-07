"use client";

import { useEffect, useRef } from "react";
import { twMerge } from "tailwind-merge";
import type { Vec } from "../../../../shared/types";
import { C, hash } from "@/lib/hive/pixel";
import { SKY_H, SKY_W, type SkySnap } from "@/lib/hive/skyLive";
import { drawJam, lerpPos, useCanvasLoop, usePointerJam } from "./canvasKit";

const CELL = 12;
const ART = 4; // scene art pixel
const AW = (SKY_W * CELL) / ART;
const AH = (SKY_H * CELL) / ART;
const SKY = ["#06080e", "#090c15", "#0c111d", "#111727", "#161d30"];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

type Star = { x: number; y: number; b: number; phase: number };

// Night scene: dithered sky, moon, hills and a lit skyline. Painted once.
function paintScene(ctx: CanvasRenderingContext2D) {
	const px = (x: number, y: number, c: string) => {
		ctx.fillStyle = c;
		ctx.fillRect(x * ART, y * ART, ART, ART);
	};

	for (let y = 0; y < AH; y++) {
		for (let x = 0; x < AW; x++) {
			const t = (y / AH) * (SKY.length - 1);
			const band = Math.floor(t);
			const up = (t - band) * 16 > BAYER[(y % 4) * 4 + (x % 4)];
			px(x, y, SKY[Math.min(SKY.length - 1, band + (up ? 1 : 0))]);
		}
	}

	const moon = { x: 166, y: 18, r: 8 };
	for (let y = -moon.r; y <= moon.r; y++) {
		for (let x = -moon.r; x <= moon.r; x++) {
			if (x * x + y * y > moon.r * moon.r) {
				continue;
			}
			const shade = x + y > 6 ? "#bdb7a8" : hash(x + 40, y + 40) % 9 === 0 ? "#cfc9ba" : "#e9e4d8";
			px(moon.x + x, moon.y + y, shade);
		}
	}

	for (let x = 0; x < AW; x++) {
		const hill = Math.round(AH - 22 + Math.sin(x / 17) * 3 + Math.sin(x / 7 + 1) * 1.5);
		for (let y = hill; y < AH; y++) {
			px(x, y, "#121827");
		}
	}

	let x = 0;
	let seed = 1;
	while (x < AW) {
		seed = (seed * 9301 + 49297) % 233280;
		const r = seed / 233280;
		const w = 6 + Math.floor(r * 10);
		const tower = x > 120 && x < 128;
		const h = tower ? 46 : 7 + Math.floor(((r * 997) % 1) * 16);

		for (let bx = x; bx < Math.min(AW, x + w); bx++) {
			for (let by = AH - h; by < AH; by++) {
				const window = (bx - x) % 3 === 1 && (by - (AH - h)) % 3 === 1 && bx < x + w - 1;
				const lit = window && hash(bx, by) % 5 === 0;
				px(bx, by, lit ? (hash(by, bx) % 3 ? "#ffb02099" : "#e9e4d877") : "#0a0d15");
			}
		}
		if (tower) {
			px(x + Math.floor(w / 2), AH - h - 1, C.ember);
		}
		x += w + (r > 0.7 ? 1 : 0);
	}
}

function makeStars(): Star[] {
	return Array.from({ length: 90 }, (_, i) => ({
		x: hash(i, 7) % AW,
		y: hash(7, i) % Math.floor(AH * 0.6),
		b: (hash(i, i) % 3) + 1,
		phase: (hash(i, 3) % 100) / 16,
	}));
}

function drawDrone(ctx: CanvasRenderingContext2D, d: SkySnap["drones"][number], p: Vec, now: number) {
	const cx = Math.round((p.x + 0.5) * CELL);
	const cy = Math.round((p.y + 0.5) * CELL);
	const lit = d.alive && d.color !== "#000000";
	const sq = (s: number, c: string, a = 1) => {
		ctx.globalAlpha = a;
		ctx.fillStyle = c;
		ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
		ctx.globalAlpha = 1;
	};

	if (!d.alive) {
		sq(4, C.dead);
		return;
	}

	if (!lit) {
		sq(6, "#2c3242");
		const blink = Math.floor(now / 500 + p.x) % 2 === 0;
		ctx.fillStyle = blink ? C.ember : "#3fdc7e";
		ctx.fillRect(cx - 1, cy - 1, 2, 2);
		return;
	}

	const flicker = d.jammed ? 0.35 + Math.random() * 0.5 : 1;
	sq(16, d.color, 0.12 * flicker);
	sq(10, d.color, 0.28 * flicker);
	sq(6, d.color, flicker);
	sq(2, "#ffffff", flicker);

	if (d.jammed && Math.random() < 0.4) {
		sq(2, C.mute);
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
		scene.current.width = SKY_W * CELL;
		scene.current.height = SKY_H * CELL;
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
			curr.current.drones.find((d) => d.alive && Math.hypot(d.pos.x + 0.5 - p.x, d.pos.y + 0.5 - p.y) < 1.3)?.id,
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
			ctx.globalAlpha = 0.25 + 0.2 * st.b * (0.6 + 0.4 * Math.sin(now / 700 + st.phase));
			ctx.fillStyle = "#e9e4d8";
			ctx.fillRect(st.x * ART, st.y * ART, ART / (st.b === 3 ? 1 : 2), ART / (st.b === 3 ? 1 : 2));
		}
		ctx.globalAlpha = 1;

		for (const j of s.jams) {
			drawJam(ctx, j.center, j.radius, CELL);
		}
		const drag = pointer.drag.current;
		if (drag) {
			drawJam(ctx, drag.start, Math.hypot(drag.now.x - drag.start.x, drag.now.y - drag.start.y), CELL);
		}

		for (const t of s.targets) {
			ctx.globalAlpha = 0.18;
			ctx.fillStyle = t.color;
			ctx.fillRect((t.pos.x + 0.5) * CELL - 1, (t.pos.y + 0.5) * CELL - 1, 2, 2);
		}
		ctx.globalAlpha = 1;

		ctx.lineWidth = 1;
		ctx.strokeStyle = "rgba(90,169,255,.12)";
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
			width={SKY_W * CELL}
			height={SKY_H * CELL}
			{...pointer.handlers}
			className={twMerge(
				"block max-w-full h-auto [image-rendering:pixelated] cursor-crosshair touch-none",
				className,
			)}
		/>
	);
}
