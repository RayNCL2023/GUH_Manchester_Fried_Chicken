"use client";

import { useState } from "react";
import FireDemo from "./FireDemo";
import SkyDemo from "./SkyDemo";
import TopBar from "./TopBar";

const TABS = [
	{ id: "fire", label: "Firebreak", Scene: FireDemo },
	{ id: "sky", label: "Flock show", Scene: SkyDemo },
];

export default function () {
	const [tab, setTab] = useState(TABS[0].id);
	const { Scene } = TABS.find((t) => t.id === tab)!;

	return (
		<div className="flex flex-col w-full min-h-screen px-[0rem] bg-ink text-white">
			<TopBar
				crumbs={["Live demo"]}
				right={
					<div className="flex flex-row items-center gap-[1.5rem]">
						<p className="hidden lg:block text-[.875rem] text-mute">Real engine · simulated world</p>
						<div className="flex flex-row border border-line">
							{TABS.map((t) => (
								<button
									key={t.id}
									onClick={() => setTab(t.id)}
									data-on={t.id === tab}
									className="min-h-[2.75rem] px-[1.25rem] text-[.875rem] bg-transparent text-mute data-[on=true]:bg-panel data-[on=true]:text-white"
								>
									{t.label}
								</button>
							))}
						</div>
					</div>
				}
			/>
			<Scene key={tab} />
		</div>
	);
}
