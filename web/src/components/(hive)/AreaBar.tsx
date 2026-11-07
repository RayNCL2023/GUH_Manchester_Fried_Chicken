"use client";

import { useState } from "react";
import { HiMagnifyingGlass } from "react-icons/hi2";
import { PRESETS, type Area } from "@/lib/hive/osm";

export default function ({
	current,
	status,
	onPreset,
	onSearch,
}: {
	current?: string;
	status: string;
	onPreset: (a: Area) => void;
	onSearch: (q: string) => void;
}) {
	const [q, setQ] = useState("");

	return (
		<div className="flex flex-col lg:flex-row lg:items-center gap-[1rem] mx-[.75rem] mt-[.75rem] p-[.75rem] rounded-[1.25rem] bg-panel border border-line">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (q.trim()) {
						onSearch(q.trim());
					}
				}}
				className="flex flex-row items-center gap-[.5rem] min-h-[2.75rem] px-[1.1rem] rounded-full bg-ink border border-line lg:w-[22rem] focus-within:border-mute"
			>
				<HiMagnifyingGlass size={16} className="text-mute shrink-0" />
				<input
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Search any place on OpenStreetMap"
					className="flex-1 bg-transparent text-white text-[1rem]"
				/>
			</form>
			<div className="flex flex-row flex-wrap gap-[.5rem]">
				{PRESETS.map((p) => (
					<button
						key={p.id}
						onClick={() => onPreset(p)}
						data-on={p.id === current}
						className="min-h-[2.75rem] px-[1.1rem] rounded-full text-[.875rem] bg-ink border border-line text-mute hover:text-white data-[on=true]:border-flock data-[on=true]:text-white"
					>
						{p.name}
					</button>
				))}
			</div>
			<p className="text-[.875rem] text-mute tabular-nums lg:ml-auto lg:pr-[.5rem]">{status}</p>
		</div>
	);
}
