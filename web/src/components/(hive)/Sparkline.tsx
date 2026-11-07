import { twMerge } from "tailwind-merge";
import { C } from "@/lib/hive/pixel";

// Stepped line: reads as pixels, and is honest about discrete samples.
export default function ({
	values,
	max = 100,
	className,
}: {
	values: number[];
	max?: number;
	className?: string;
}) {
	const w = 120;
	const h = 40;
	if (values.length < 2) {
		return <div className={twMerge("w-full", className)} />;
	}

	const step = w / (values.length - 1);
	const y = (v: number) => h - (v / max) * h;
	const d = values.reduce((acc, v, i) => (i ? `${acc} L${i * step} ${y(v)}` : `M0 ${y(v)}`), "");

	return (
		<svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={twMerge("w-full", className)}>
			<path d={`${d} V${h} H0 Z`} fill={C.flock} fillOpacity={0.12} />
			<path d={d} fill="none" stroke={C.flock} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
		</svg>
	);
}
