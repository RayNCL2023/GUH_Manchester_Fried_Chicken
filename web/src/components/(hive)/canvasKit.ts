"use client";

import { useEffect, useRef } from "react";
import type { Vec } from "../../../../shared/types";

let family = "";
// Canvas can't read CSS variables, so resolve the page font once.
export const font = (weight: number, px: number) => {
	family ||= getComputedStyle(document.body).fontFamily || "sans-serif";
	return `${weight} ${px}px ${family}`;
};

export const lerpPos = (from: Vec | undefined, to: Vec, t: number): Vec =>
	from ? { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t } : to;

// One rounded "pixel": a soft dot with a gap around it.
export function dot(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number, color: string) {
	const g = Math.max(1, cell * 0.12);
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.roundRect(x * cell + g / 2, y * cell + g / 2, cell - g, cell - g, (cell - g) * 0.38);
	ctx.fill();
}

// Jam zone: soft grey disc with a dotted rim.
export function drawJam(ctx: CanvasRenderingContext2D, center: Vec, radius: number, cell: number) {
	const cx = center.x * cell;
	const cy = center.y * cell;
	const r = radius * cell;

	ctx.fillStyle = "rgba(139,139,148,.14)";
	ctx.beginPath();
	ctx.arc(cx, cy, r, 0, Math.PI * 2);
	ctx.fill();

	ctx.strokeStyle = "rgba(139,139,148,.8)";
	ctx.lineWidth = 3;
	ctx.lineCap = "round";
	ctx.setLineDash([0.1, 9]);
	ctx.beginPath();
	ctx.arc(cx, cy, r, 0, Math.PI * 2);
	ctx.stroke();
	ctx.setLineDash([]);

	ctx.font = font(500, 14);
	const label = "Jam zone";
	const tw = ctx.measureText(label).width;
	ctx.fillStyle = "rgba(15,15,17,.85)";
	ctx.beginPath();
	ctx.roundRect(cx - tw / 2 - 8, cy - r - 26, tw + 16, 20, 10);
	ctx.fill();
	ctx.fillStyle = "#8b8b94";
	ctx.fillText(label, cx - tw / 2, cy - r - 11);
}

// requestAnimationFrame loop bound to a canvas.
export function useCanvasLoop(draw: (ctx: CanvasRenderingContext2D, now: number) => void) {
	const ref = useRef<HTMLCanvasElement>(null);
	const drawRef = useRef(draw);
	drawRef.current = draw;

	useEffect(() => {
		let raf = 0;
		const loop = (now: number) => {
			const ctx = ref.current?.getContext("2d");
			if (ctx) {
				ctx.imageSmoothingEnabled = false;
				drawRef.current(ctx, now);
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, []);

	return ref;
}

// Click a drone, or drag on empty ground to draw a jam zone.
export function usePointerJam({
	size,
	hitTest,
	onHit,
	onEmptyClick,
	onEmptyDown,
	onJam,
}: {
	size: { w: number; h: number };
	hitTest: (p: Vec) => string | undefined;
	onHit: (id: string, shift: boolean) => void;
	onEmptyClick?: () => void;
	onEmptyDown?: (p: Vec) => boolean;
	onJam?: (center: Vec, radius: number) => void;
}) {
	const drag = useRef<{ start: Vec; now: Vec } | null>(null);

	const toCell = (e: React.PointerEvent<HTMLCanvasElement>): Vec => {
		const r = e.currentTarget.getBoundingClientRect();
		return { x: ((e.clientX - r.left) / r.width) * size.w, y: ((e.clientY - r.top) / r.height) * size.h };
	};

	const handlers = {
		onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
			const p = toCell(e);
			const id = hitTest(p);
			if (id) {
				onHit(id, e.shiftKey);
				return;
			}
			if (onEmptyDown?.(p)) {
				return;
			}
			drag.current = { start: p, now: p };
			e.currentTarget.setPointerCapture(e.pointerId);
		},
		onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
			if (!drag.current) {
				return;
			}
			drag.current.now = toCell(e);
		},
		onPointerUp: () => {
			const d = drag.current;
			drag.current = null;
			if (!d) {
				return;
			}
			const r = Math.hypot(d.now.x - d.start.x, d.now.y - d.start.y);
			if (r > 1.2) {
				onJam?.(d.start, Math.round(r));
				return;
			}
			onEmptyClick?.();
		},
	};

	return { drag, handlers };
}
