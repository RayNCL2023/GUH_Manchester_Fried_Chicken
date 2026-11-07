"use client";

// 16-colour pixel editor. Drag to paint (mouse or finger); the ink swatch erases.
import { useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import { ART_COLORS } from "@/lib/hive/pixel";
import { PALETTE } from "@/lib/hive/uplink";

export default function ({ art, onChange, disabled }: { art: string[]; onChange: (art: string[]) => void; disabled?: boolean }) {
	const [ink, setInk] = useState("o");
	const painting = useRef(false);
	const w = art[0].length;
	const h = art.length;

	const paint = (e: React.PointerEvent<HTMLDivElement>) => {
		if (disabled || !painting.current) {
			return;
		}
		const r = e.currentTarget.getBoundingClientRect();
		const x = Math.floor(((e.clientX - r.left) / r.width) * w);
		const y = Math.floor(((e.clientY - r.top) / r.height) * h);
		if (x < 0 || y < 0 || x >= w || y >= h || art[y][x] === ink) {
			return;
		}
		onChange(art.map((row, ry) => (ry === y ? row.slice(0, x) + ink + row.slice(x + 1) : row)));
	};

	return (
		<div className="flex flex-col gap-[1rem]">
			<div
				aria-label="Drawing grid"
				className={twMerge("grid w-full max-w-[28rem] aspect-square touch-none select-none gap-[.1rem] p-[.1rem] rounded-[.75rem] bg-line", disabled ? "opacity-60" : "cursor-crosshair")}
				style={{ gridTemplateColumns: `repeat(${w}, 1fr)` }}
				onPointerDown={(e) => {
					painting.current = true;
					e.currentTarget.setPointerCapture(e.pointerId);
					paint(e);
				}}
				onPointerMove={paint}
				onPointerUp={() => (painting.current = false)}
				onPointerCancel={() => (painting.current = false)}
			>
				{art.flatMap((row, y) => [...row].map((ch, x) => <span key={`${x}-${y}`} className="rounded-[.15rem]" style={{ background: ART_COLORS[ch] }} />))}
			</div>
			<div className="flex flex-row flex-wrap gap-[.4rem]" aria-label="Palette">
				{PALETTE.map((ch) => (
					<button
						key={ch}
						title={ch === "." ? "Eraser" : ch}
						onClick={() => setInk(ch)}
						data-on={ink === ch}
						className="w-[2.75rem] h-[2.75rem] rounded-[.6rem] border border-line data-[on=true]:border-white data-[on=true]:scale-110 transition-transform"
						style={{ background: ART_COLORS[ch] }}
					>
						{ch === "." && <span className="text-[.875rem] text-mute">✕</span>}
					</button>
				))}
			</div>
		</div>
	);
}
