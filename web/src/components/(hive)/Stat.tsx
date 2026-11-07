import { twMerge } from "tailwind-merge";

export default function ({
	label,
	value,
	unit,
	className,
}: {
	label: string;
	value: React.ReactNode;
	unit?: string;
	className?: string;
}) {
	return (
		<div className={twMerge("flex flex-col gap-[.5rem] p-[1.25rem] border-line", className)}>
			<p className="text-[.875rem] text-mute">{label}</p>
			<p className="font-display text-[1.75rem] leading-none tracking-tight text-white tabular-nums">
				{value}
				{unit && <span className="text-mute text-[1rem] ml-[.35rem]">{unit}</span>}
			</p>
		</div>
	);
}
