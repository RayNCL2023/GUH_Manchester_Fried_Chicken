import { ART_COLORS } from "@/lib/hive/pixel";
import { BLOCK, PALETTE, PAYLOAD_HEAD, blockOfPixel, pixelAt } from "@/lib/hive/uplink";

// The picture as it assembles: a pixel lights up once the fountain block holding it is known.
// Pixels inside a block light one after another, so the image visibly fills in pixel by pixel.
export default function ({
	w,
	h,
	payload,
	solved,
	cell = "1.75rem",
}: {
	w: number;
	h: number;
	payload: Uint8Array;
	solved: Set<number>;
	cell?: string;
}) {
	return (
		<div
			aria-label="Picture received over sound"
			className="grid"
			style={{ gridTemplateColumns: `repeat(${w}, ${cell})`, gridAutoRows: cell, gap: `calc(${cell} * .12)` }}
		>
			{Array.from({ length: w * h }, (_, i) => {
				const known = solved.has(blockOfPixel(i));
				const ch = PALETTE[pixelAt(payload, i)] ?? ".";
				const lit = known && ch !== ".";
				// Spread each block's reveal over ~1.4 s however big the blocks are.
				const step = (((PAYLOAD_HEAD * 2 + i) % (BLOCK * 2)) * 1400) / (BLOCK * 2);
				return (
					<span
						key={i}
						className="rounded-[30%] border transition-[background-color,transform,opacity,border-color] duration-300"
						style={{
							background: lit ? ART_COLORS[ch] : "transparent",
							borderColor: lit ? ART_COLORS[ch] : known ? "#1f1f23" : "#2a2a2f",
							opacity: known ? 1 : 0.5,
							transform: known ? "scale(1)" : "scale(.55)",
							transitionDelay: known ? `${step}ms` : "0ms",
						}}
					/>
				);
			})}
		</div>
	);
}
