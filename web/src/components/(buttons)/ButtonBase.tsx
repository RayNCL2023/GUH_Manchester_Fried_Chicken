import { twMerge } from "tailwind-merge";

export default function ({
	children,
	className,
	...props
}: React.JSX.IntrinsicElements["button"]) {
	return (
		<button
			className={twMerge(
				"flex flex-row items-center justify-center gap-[.5rem] min-h-[2.75rem] px-[1.1rem] rounded-full border border-line bg-ink text-white text-[.875rem] hover:border-mute transition-colors",
				className,
			)}
			{...props}
		>
			{children}
		</button>
	);
}
