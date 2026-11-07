import { twMerge } from "tailwind-merge";

export default function ({ className, children, ...props }: React.JSX.IntrinsicElements["div"]) {
	return (
		<div
			className={twMerge("flex flex-row items-center gap-[.5rem] min-h-[2.75rem] px-[1rem] rounded-full border border-line text-[.875rem]", className)}
			{...props}
		>
			{children}
		</div>
	);
}
