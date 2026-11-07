"use client";

import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { C } from "@/lib/hive/pixel";
import { phoneJoinUrl, serverUrl } from "@/lib/hive/server";

export default function () {
	const [join, setJoin] = useState<{ url: string; lan: boolean } | null>(null);
	useEffect(() => {
		// No server means nobody can actually join, so don't advertise it.
		if (!serverUrl()) {
			return;
		}
		void phoneJoinUrl().then(setJoin);
	}, []);

	if (!join) {
		return null;
	}

	return (
		<section className="flex flex-row items-center gap-[1.25rem] p-[1.25rem] rounded-[1.25rem] bg-panel border border-line">
			<div className="p-[.6rem] bg-white rounded-[.9rem] shrink-0">
				<QRCode value={join.url} size={104} bgColor="#ffffff" fgColor={C.ink} />
			</div>
			<div className="flex flex-col gap-[.4rem] min-w-0">
				<p className="font-display text-[1.5rem] leading-[1.1] tracking-tight text-white">Scan to join the flock.</p>
				<p className="text-[.875rem] leading-relaxed text-mute">Jam the radio, turn the wind, or take a drone down.</p>
				<p className="text-[.875rem] text-mute break-all">
					{join.url.replace(/^https?:\/\//, "")}
					{join.lan && <span className="text-flock"> · same wifi as this laptop</span>}
				</p>
			</div>
		</section>
	);
}
