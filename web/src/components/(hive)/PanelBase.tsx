import { twMerge } from "tailwind-merge";

export default function ({
	index,
	title,
	aside,
	children,
	className,
	...props
}: Omit<React.JSX.IntrinsicElements["section"], "title"> & {
	index?: string;
	title?: React.ReactNode;
	aside?: React.ReactNode;
}) {
	return (
		<section
			className={twMerge("flex flex-col gap-[1rem] p-[1.25rem] border-line", className)}
			{...props}
		>
			{(index || title) && (
				<header className="flex flex-row flex-wrap items-baseline justify-between gap-[1rem]">
					<p className="text-[.875rem] text-mute">
						{index && <span className="text-flock mr-[.5rem]">{index}/</span>}
						{title}
					</p>
					{aside}
				</header>
			)}
			{children}
		</section>
	);
}
