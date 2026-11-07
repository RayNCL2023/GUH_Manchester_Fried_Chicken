"use client";

import { useEffect, useRef } from "react";
import { twMerge } from "tailwind-merge";
import type { Vec, WorldView } from "../../../../shared/types";
import { C, MODE_COLOR, hash } from "@/lib/hive/pixel";
import { STYLE, paintTerrain, waterCells } from "@/lib/hive/mapStyle";
import { FUEL, T } from "@/lib/hive/osm";
import { dot, drawJam, font, lerpPos, useCanvasLoop, usePointerJam } from "./canvasKit";

export const MAP_CELL = 12;
const CELL = MAP_CELL;

type Agent = WorldView["agents"][number];
export type Tool = "ignite" | "jam";

const fireColor = () => {
	const r = Math.random();
	return r < 0.08 ? C.glow : r < 0.43 ? C.amber : r < 0.83 ? C.fire : C.ember;
};

const pip = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) => {
	ctx.fillStyle = c;
	ctx.beginPath();
	ctx.arc((x + 0.5) * CELL, (y + 0.5) * CELL, r, 0, Math.PI * 2);
	ctx.fill();
};

// Satellite photo, dimmed a touch so fire and drones pop. The fire grid sits on top:
// firebreaks (water, roads) as coloured pips, everything else as a faint lattice.
function paintSatellite(ctx: CanvasRenderingContext2D, sat: HTMLCanvasElement, terrain: Uint8Array, w: number, grid: boolean) {
	ctx.drawImage(sat, 0, 0, ctx.canvas.width, ctx.canvas.height);
	ctx.fillStyle = "rgba(8,10,16,.28)";
	ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	if (!grid) {
		return;
	}

	for (let i = 0; i < terrain.length; i++) {
		const t = terrain[i];
		const x = i % w;
		const y = (i / w) | 0;
		if (t === T.water) {
			pip(ctx, x, y, 2.6, "rgba(110,200,255,.6)");
		} else if (FUEL[t] <= 0.06) {
			pip(ctx, x, y, 2.6, "rgba(245,210,102,.6)");
		} else {
			pip(ctx, x, y, 0.9, "rgba(255,255,255,.14)");
		}
	}
}

// Per tick: base layer, then fire light, flames, burn scars and (pixel view) water sparkle.
function paintTick(
	ctx: CanvasRenderingContext2D,
	base: HTMLCanvasElement,
	v: WorldView,
	terrain: Uint8Array,
	water: number[],
	sat: boolean,
) {
	const { width: w } = v;
	const belief = v.inspected?.map;
	ctx.drawImage(base, 0, 0);

	for (let k = 0; !sat && k < water.length * 0.015; k++) {
		const i = water[(Math.random() * water.length) | 0];
		dot(ctx, i % w, (i / w) | 0, CELL, STYLE.sparkle);
	}

	// Fire lights up what's around it.
	ctx.globalCompositeOperation = "lighter";
	for (let i = 0; i < v.cells.length; i++) {
		if (v.cells[i] !== "fire") {
			continue;
		}
		const gx = ((i % w) + 0.5) * CELL;
		const gy = (((i / w) | 0) + 0.5) * CELL;
		const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, CELL * 2.2);
		g.addColorStop(0, "rgba(255,110,30,.22)");
		g.addColorStop(1, "rgba(255,110,30,0)");
		ctx.fillStyle = g;
		ctx.fillRect(gx - CELL * 2.2, gy - CELL * 2.2, CELL * 4.4, CELL * 4.4);
	}
	ctx.globalCompositeOperation = "source-over";

	for (let i = 0; i < v.cells.length; i++) {
		const s = v.cells[i];
		const x = i % w;
		const y = (i / w) | 0;

		if (s === "fire") {
			dot(ctx, x, y, CELL, fireColor());
		} else if (s === "burnt") {
			const ember = hash(x, y) % 9 === 0 && Math.random() < 0.3;
			const scar = sat
				? terrain[i] === T.building
					? "rgba(70,28,16,.88)"
					: "rgba(24,15,11,.78)"
				: terrain[i] === T.building
					? STYLE.burntBuilding
					: STYLE.burnt[hash(x, y) % 3];
			dot(ctx, x, y, CELL, ember ? C.ember : scar);
		}
		if (belief && belief[i] === "u") {
			ctx.fillStyle = "rgba(15,15,17,.86)";
			ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
		}
	}

	for (const j of v.jamZones) {
		drawJam(ctx, j.center, j.radius, CELL);
	}
}

const circle = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) => {
	ctx.fillStyle = c;
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.fill();
};

// Round quad: body, four rotors, white core, all on an ink halo so it reads over fire.
function drawDrone(ctx: CanvasRenderingContext2D, a: Agent, p: Vec, selected: boolean) {
	const cx = (p.x + 0.5) * CELL;
	const cy = (p.y + 0.5) * CELL;
	const col = a.jammed && a.alive ? C.mute : (MODE_COLOR[a.mode] ?? C.flock);
	const rotors = [[-6, -6], [6, -6], [-6, 6], [6, 6]];

	circle(ctx, cx, cy, 13, "rgba(15,15,17,.75)");
	for (const [dx, dy] of rotors) {
		circle(ctx, cx + dx, cy + dy, 3.2, a.jammed && Math.random() < 0.3 ? C.ink : col);
	}
	circle(ctx, cx, cy, 5, col);
	if (a.alive) {
		circle(ctx, cx, cy, 2, C.text);
	}

	const label = a.id.replace("Echo-", "E");
	ctx.font = font(600, 13);
	const tw = ctx.measureText(label).width;
	ctx.fillStyle = "rgba(15,15,17,.85)";
	ctx.beginPath();
	ctx.roundRect(cx + 12, cy - 22, tw + 12, 17, 8.5);
	ctx.fill();
	ctx.fillStyle = col;
	ctx.fillText(label, cx + 18, cy - 9);

	if (!selected || !a.alive) {
		return;
	}

	ctx.strokeStyle = C.flock;
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.arc(cx, cy, 15, 0, Math.PI * 2);
	ctx.stroke();
	ctx.setLineDash([2, 6]);
	ctx.lineCap = "round";
	ctx.beginPath();
	ctx.arc(cx, cy, 7.5 * CELL, 0, Math.PI * 2);
	ctx.stroke();
	ctx.setLineDash([]);
}

export default function ({
	view,
	terrain,
	satellite = null,
	showGrid = true,
	tool = "jam",
	onIgnite,
	selected = null,
	onSelect,
	onKill,
	onJam,
	className,
}: {
	view: WorldView;
	terrain: Uint8Array;
	satellite?: HTMLCanvasElement | null;
	showGrid?: boolean;
	tool?: Tool;
	onIgnite?: (at: Vec) => void;
	selected?: string | null;
	onSelect?: (id: string | null) => void;
	onKill?: (id: string) => void;
	onJam?: (center: Vec, radius: number) => void;
	className?: string;
}) {
	const base = useRef<HTMLCanvasElement | null>(null);
	const water = useRef<number[]>([]);
	const frame = useRef<HTMLCanvasElement | null>(null);
	const prev = useRef(new Map<string, Vec>());
	const curr = useRef(view);
	const changedAt = useRef(0);

	useEffect(() => {
		base.current = document.createElement("canvas");
		base.current.width = view.width * CELL;
		base.current.height = view.height * CELL;
		const ctx = base.current.getContext("2d")!;
		if (satellite) {
			paintSatellite(ctx, satellite, terrain, view.width, showGrid);
		} else {
			paintTerrain(ctx, terrain, view.width, view.height, CELL, (x, y, c) => dot(ctx, x, y, CELL, c));
		}
		water.current = waterCells(terrain);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [terrain, satellite, showGrid]);

	useEffect(() => {
		prev.current = new Map(curr.current.agents.map((a) => [a.id, a.pos]));
		curr.current = view;
		changedAt.current = performance.now();
		if (!base.current) {
			return;
		}

		frame.current ??= document.createElement("canvas");
		frame.current.width = view.width * CELL;
		frame.current.height = view.height * CELL;
		paintTick(frame.current.getContext("2d")!, base.current, view, terrain, water.current, !!satellite);
	}, [view, terrain, satellite, showGrid]);

	const pointer = usePointerJam({
		size: { w: view.width, h: view.height },
		hitTest: (p) =>
			curr.current.agents.find((a) => a.alive && Math.hypot(a.pos.x + 0.5 - p.x, a.pos.y + 0.5 - p.y) < 1.8)?.id,
		onHit: (id, shift) => (shift ? onKill?.(id) : onSelect?.(id === selected ? null : id)),
		onEmptyDown: tool === "ignite" ? (p) => (onIgnite?.(p), true) : undefined,
		onEmptyClick: () => onSelect?.(null),
		onJam,
	});

	const ref = useCanvasLoop((ctx, now) => {
		const v = curr.current;
		if (!frame.current) {
			return;
		}

		ctx.drawImage(frame.current, 0, 0);
		const drag = pointer.drag.current;
		if (drag) {
			drawJam(ctx, drag.start, Math.hypot(drag.now.x - drag.start.x, drag.now.y - drag.start.y), CELL);
		}

		const t = Math.min(1, (now - changedAt.current) / 100);
		const pos = new Map(v.agents.map((a) => [a.id, lerpPos(prev.current.get(a.id), a.pos, t)]));

		ctx.lineWidth = 2;
		ctx.lineCap = "round";
		ctx.setLineDash([1, 6]);
		ctx.strokeStyle = "rgba(90,169,255,.6)";
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
			data-tool={tool}
			className={twMerge(
				"block max-w-full h-auto rounded-[1rem] touch-none data-[tool=ignite]:cursor-cell cursor-crosshair",
				className,
			)}
		/>
	);
}
