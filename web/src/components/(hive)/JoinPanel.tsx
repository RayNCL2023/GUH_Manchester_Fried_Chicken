"use client";

import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { C } from "@/lib/hive/pixel";
import { serverQuery } from "@/lib/hive/server";

export default function () {
	const [url, setUrl] = useState("");
	useEffect(() => setUrl(`${window.location.origin}/join${serverQuery()}`), []);

	return (
		<section className="flex flex-row items-center gap-[1.25rem] p-[1.25rem] rounded-[1.25rem] bg-panel border border-line">
			<div className="p-[.6rem] bg-white rounded-[.9rem] shrink-0">
				{url && <QRCode value={url} size={104} bgColor="#ffffff" fgColor={C.ink} />}
			</div>
			<div className="flex flex-col gap-[.4rem]">
				<p className="font-display text-[1.5rem] leading-[1.1] tracking-tight text-white">Scan to join the flock.</p>
				<p className="text-[.875rem] leading-relaxed text-mute">Jam the radio, turn the wind, or take a drone down.</p>
			</div>
		</section>
	);
}
