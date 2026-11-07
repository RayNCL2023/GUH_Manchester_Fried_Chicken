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

// Dithered jam zone: grey rim plus a sparse hatch inside.
export function drawJam(ctx: CanvasRenderingContext2D, center: Vec, radius: number, cell: number) {
	const x0 = Math.floor(center.x - radius - 1);
	const y0 = Math.floor(center.y - radius - 1);

	for (let y = y0; y <= center.y + radius + 1; y++) {
		for (let x = x0; x <= center.x + radius + 1; x++) {
			const d = Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y);
			if (d > radius + 0.5) {
				continue;
			}
			const rim = Math.abs(d - radius) < 0.55;
			if (!rim && (x + y) % 3 !== 0) {
				continue;
			}
			ctx.fillStyle = rim ? "rgba(139,139,148,.75)" : "rgba(139,139,148,.22)";
			ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
		}
	}

	ctx.font = font(500, 14);
	ctx.fillStyle = "#8b8b94";
	ctx.fillText("Jam zone", (center.x - radius) * cell, (center.y - radius) * cell - 8);
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
	onJam,
}: {
	size: { w: number; h: number };
	hitTest: (p: Vec) => string | undefined;
	onHit: (id: string, shift: boolean) => void;
	onEmptyClick?: () => void;
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
