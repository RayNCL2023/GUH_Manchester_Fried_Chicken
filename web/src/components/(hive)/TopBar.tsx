import PixelArt from "./PixelArt";
import { MARK } from "@/lib/hive/pixel";

export default function ({ crumbs, right }: { crumbs: string[]; right?: React.ReactNode }) {
	return (
		<header className="flex flex-row items-center justify-between gap-[1rem] w-full px-[1.25rem] py-[1rem] border-b border-line">
			<div className="flex flex-row items-center gap-[.75rem]">
				<PixelArt art={MARK} size=".25rem" />
				<p className="font-display text-white text-[1.25rem] font-[600] tracking-tight">Hive</p>
				{crumbs.map((c) => (
					<p key={c} className="hidden md:block text-mute text-[1rem]">
						<span className="mr-[.75rem] text-line">/</span>
						{c}
					</p>
				))}
			</div>
			{right}
		</header>
	);
}
