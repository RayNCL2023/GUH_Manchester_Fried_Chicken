"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Live } from "./types";

const TICK_MS = 100;

// Runs a world at 10 Hz in the browser and publishes a snapshot each tick.
export default function useLive<W extends Live<unknown>>(make: () => W) {
	type S = ReturnType<W["snapshot"]>;
	const world = useRef<W | null>(null);
	const [snap, setSnap] = useState<S | null>(null);

	useEffect(() => {
		const w = make();
		world.current = w;
		setSnap(w.snapshot() as S);

		const id = setInterval(() => {
			w.step();
			setSnap(w.snapshot() as S);
		}, TICK_MS);

		return () => clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const act = useCallback((fn: (w: W) => void) => {
		const w = world.current;
		if (!w) {
			return;
		}
		fn(w);
		setSnap(w.snapshot() as S);
	}, []);

	return { snap, act };
}
