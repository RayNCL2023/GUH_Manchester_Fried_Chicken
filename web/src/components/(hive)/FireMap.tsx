"use client";

import { useEffect, useRef } from "react";
import { twMerge } from "tailwind-merge";
import type { Vec, WorldView } from "../../../../shared/types";
import { C, DRONE, MODE_COLOR, hash } from "@/lib/hive/pixel";
import { drawJam, font, lerpPos, useCanvasLoop, usePointerJam } from "./canvasKit";

const CELL = 16;
const SPRITE_PX = 2;
const VILLAGE_NAME = "Diggle";

type Agent = WorldView["agents"][number];

function cellColor(state: string, x: number, y: number) {
	if (state === "fire") {
		const r = Math.random();
		return r < 0.08 ? C.glow : r < 0.43 ? C.amber : r < 0.83 ? C.fire : C.ember;
	}
	if (state === "burnt") {
		return hash(x, y) % 6 === 0 ? "#3a1f16" : "#231a16";
	}
	if (state === "village") {
		return (x + y) % 2 ? "#e9e4d8" : "#d4cebf";
	}
	return ["#18181b", "#1b1b1f", "#161619"][hash(x, y) % 3];
}

// Ground layer, rebuilt once per tick (10 Hz flicker reads as pixel fire).
function paintGround(ctx: CanvasRenderingContext2D, v: WorldView) {
	const { width: w } = v;
	const belief = v.inspected?.map;
	let vx = 0;
	let vy = Infinity;

	ctx.fillStyle = C.ink;
	ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

	for (let i = 0; i < v.cells.length; i++) {
		const x = i % w;
		const y = (i / w) | 0;
		ctx.fillStyle = cellColor(v.cells[i], x, y);
		ctx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);

		if (v.cells[i] === "village" && y < vy) {
			vx = x;
			vy = y;
		}
		if (belief && belief[i] === "u") {
			ctx.fillStyle = "rgba(15,15,17,.86)";
			ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
		}
	}

	if (vy !== Infinity) {
		ctx.font = font(500, 15);
		ctx.fillStyle = C.text;
		ctx.fillText(VILLAGE_NAME, vx * CELL, vy * CELL - 8);
	}

	for (const j of v.jamZones) {
		drawJam(ctx, j.center, j.radius, CELL);
	}
}

// Ink outline first, so drones stay readable over bright fire.
function drawDrone(ctx: CanvasRenderingContext2D, a: Agent, p: Vec, selected: boolean) {
	const cx = Math.round((p.x + 0.5) * CELL);
	const cy = Math.round((p.y + 0.5) * CELL);
	const ox = cx - 7;
	const oy = cy - 7;
	const col = a.jammed && a.alive ? C.mute : (MODE_COLOR[a.mode] ?? C.flock);

	for (const pass of ["outline", "fill"] as const) {
		DRONE.forEach((row, ry) =>
			[...row].forEach((ch, rx) => {
				if (ch === ".") {
					return;
				}
				const px = ox + rx * SPRITE_PX;
				const py = oy + ry * SPRITE_PX;

				if (pass === "outline") {
					ctx.fillStyle = C.ink;
					ctx.fillRect(px - 2, py - 2, SPRITE_PX + 4, SPRITE_PX + 4);
					return;
				}

				let fill = ch === "o" && a.alive ? C.text : col;
				if (a.jammed && a.alive && Math.random() < 0.3) {
					fill = Math.random() < 0.5 ? C.text : C.ink;
				}
				ctx.fillStyle = fill;
				ctx.fillRect(px, py, SPRITE_PX, SPRITE_PX);
			}),
		);
	}

	const label = a.id.replace("Echo-", "E");
	ctx.font = font(600, 13);
	ctx.fillStyle = C.ink;
	ctx.fillRect(ox + 16, oy - 12, ctx.measureText(label).width + 6, 15);
	ctx.fillStyle = col;
	ctx.fillText(label, ox + 19, oy);

	if (!selected || !a.alive) {
		return;
	}

	ctx.strokeStyle = C.flock;
	ctx.lineWidth = 2;
	ctx.strokeRect(ox - 4, oy - 4, 22, 22);
	ctx.setLineDash([3, 5]);
	ctx.beginPath();
	ctx.arc(cx, cy, 5.5 * CELL, 0, Math.PI * 2);
	ctx.stroke();
	ctx.setLineDash([]);
}

export default function ({
	view,
	selected = null,
	onSelect,
	onKill,
	onJam,
	className,
}: {
	view: WorldView;
	selected?: string | null;
	onSelect?: (id: string | null) => void;
	onKill?: (id: string) => void;
	onJam?: (center: Vec, radius: number) => void;
	className?: string;
}) {
	const ground = useRef<HTMLCanvasElement | null>(null);
	const prev = useRef(new Map<string, Vec>());
	const curr = useRef(view);
	const changedAt = useRef(0);

	useEffect(() => {
		prev.current = new Map(curr.current.agents.map((a) => [a.id, a.pos]));
		curr.current = view;
		changedAt.current = performance.now();

		ground.current ??= document.createElement("canvas");
		ground.current.width = view.width * CELL;
		ground.current.height = view.height * CELL;
		paintGround(ground.current.getContext("2d")!, view);
	}, [view]);

	const pointer = usePointerJam({
		size: { w: view.width, h: view.height },
		hitTest: (p) =>
			curr.current.agents.find((a) => a.alive && Math.hypot(a.pos.x + 0.5 - p.x, a.pos.y + 0.5 - p.y) < 1.5)?.id,
		onHit: (id, shift) => (shift ? onKill?.(id) : onSelect?.(id === selected ? null : id)),
		onEmptyClick: () => onSelect?.(null),
		onJam,
	});

	const ref = useCanvasLoop((ctx, now) => {
		const v = curr.current;
		if (!ground.current) {
			return;
		}

		ctx.drawImage(ground.current, 0, 0);
		const drag = pointer.drag.current;
		if (drag) {
			drawJam(ctx, drag.start, Math.hypot(drag.now.x - drag.start.x, drag.now.y - drag.start.y), CELL);
		}

		const t = Math.min(1, (now - changedAt.current) / 100);
		const pos = new Map(v.agents.map((a) => [a.id, lerpPos(prev.current.get(a.id), a.pos, t)]));

		ctx.lineWidth = 2;
		ctx.setLineDash([4, 4]);
		ctx.strokeStyle = "rgba(90,169,255,.55)";
		for (const [ia, ib] of v.links) {
			const a = pos.get(ia);
			const b = pos.get(ib);
			if (!a || !b) {
				continue;
			}
			ctx.beginPath();
			ctx.moveTo((a.x + 0.5) * CELL, (a.y + 0.5) * CELL);
			ctx.lineTo((b.x + 0.5) * CELL, (b.y + 0.5) * CELL);
			ctx.stroke();
		}
		ctx.setLineDash([]);

		for (const a of v.agents) {
			drawDrone(ctx, a, pos.get(a.id)!, a.id === selected);
		}
	});

	return (
		<canvas
			ref={ref}
			width={view.width * CELL}
			height={view.height * CELL}
			{...pointer.handlers}
			className={twMerge(
				"block max-w-full h-auto [image-rendering:pixelated] cursor-crosshair touch-none",
				className,
			)}
		/>
	);
}
