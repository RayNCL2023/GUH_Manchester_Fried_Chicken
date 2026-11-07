"use client";

import { Suspense, lazy, useEffect, useState } from "react";
import { serverUrl } from "@/lib/hive/server";
import PhonesDemo from "./PhonesDemo";
import ResultsPanel from "./ResultsPanel";
import SkyDemo from "./SkyDemo";
import TopBar from "./TopBar";

// three.js + Google tiles load lazily so the shell paints first.
const World3D = lazy(() => import("./World3D"));

const BASE_TABS = [
	{ id: "fire", label: "Firebreak", Scene: World3D },
	{ id: "sky", label: "Flock show", Scene: SkyDemo },
];
// With a live server, the real phone light show joins the tabs.
const LIVE_TABS = [BASE_TABS[0], { id: "phones", label: "Phone light show", Scene: PhonesDemo }, BASE_TABS[1]];

export default function () {
	const [TABS, setTabs] = useState(BASE_TABS);
	const [live, setLive] = useState(false);
	useEffect(() => {
		if (serverUrl()) {
			setTabs(LIVE_TABS);
			setLive(true);
		}
	}, []);
	const [tab, setTab] = useState(BASE_TABS[0].id);
	const { Scene } = TABS.find((t) => t.id === tab) ?? TABS[0];

	return (
		<div className="flex flex-col w-full min-h-screen px-[0rem] bg-ink text-white">
			<TopBar
				crumbs={["Live demo"]}
				right={
					<div className="flex flex-row items-center gap-[1.5rem]">
						<p className="hidden lg:block text-[.875rem] text-mute">{live ? "Real engine · live server" : "Real engine · simulated world"}</p>
						<div className="flex flex-row gap-[.25rem] p-[.25rem] rounded-full border border-line bg-ink">
							{TABS.map((t) => (
								<button
									key={t.id}
									onClick={() => setTab(t.id)}
									data-on={t.id === tab}
									className="min-h-[2.25rem] px-[1.25rem] rounded-full text-[.875rem] bg-transparent text-mute data-[on=true]:bg-white data-[on=true]:text-ink"
								>
									{t.label}
								</button>
							))}
						</div>
					</div>
				}
			/>
			<Suspense fallback={<p className="p-[2rem] text-mute">Loading 3D world…</p>}>
				<Scene key={tab} />
			</Suspense>
			<ResultsPanel />
		</div>
	);
}
