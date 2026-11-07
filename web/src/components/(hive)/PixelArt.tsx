import { twMerge } from "tailwind-merge";
import { ART_COLORS } from "@/lib/hive/pixel";

export default function ({
	art,
	size = ".5rem",
	className,
}: {
	art: string[];
	size?: string;
	className?: string;
}) {
	return (
		<div
			aria-hidden
			className={twMerge("grid shrink-0", className)}
			style={{ gridTemplateColumns: `repeat(${art[0].length}, ${size})`, gridAutoRows: size, gap: `calc(${size} * .15)` }}
		>
			{art.flatMap((row, y) =>
				[...row].map((ch, x) => (
					<span
						key={`${x}-${y}`}
						className="rounded-[35%]"
						style={{ background: ch === "." ? "transparent" : ART_COLORS[ch] }}
					/>
				)),
			)}
		</div>
	);
}
