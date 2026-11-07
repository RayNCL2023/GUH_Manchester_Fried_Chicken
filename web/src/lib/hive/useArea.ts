"use client";

import { useCallback, useEffect, useState } from "react";
import { PRESETS, geocode, loadArea, type Area, type LoadedArea } from "./osm";
import { loadSatellite } from "./satellite";

// Area picker state shared by the 2D and 3D views: presets, place search, and satellite imagery.
export default function useArea(cellPx: number) {
	const [area, setArea] = useState<LoadedArea | null>(null);
	const [satellite, setSatellite] = useState<{ id: string; canvas: HTMLCanvasElement } | null>(null);
	const [status, setStatus] = useState("Loading map");

	const pick = useCallback(
		async (a: Area) => {
			setStatus(`Loading ${a.name} from OpenStreetMap`);
			try {
				const loaded = await loadArea(a);
				setArea(loaded);
				loadSatellite(loaded, cellPx).then((canvas) => setSatellite({ id: loaded.id, canvas }));
				setStatus(`${loaded.counts.buildings.toLocaleString("en-GB")} buildings · ${loaded.counts.roads.toLocaleString("en-GB")} roads`);
			} catch {
				setStatus(`Couldn't load ${a.name}. Overpass may be busy, try a preset.`);
			}
		},
		[cellPx],
	);

	const search = useCallback(
		async (q: string) => {
			setStatus(`Searching for "${q}"`);
			try {
				const hit = await geocode(q);
				if (!hit) {
					setStatus(`No place called "${q}"`);
					return;
				}
				await pick(hit);
			} catch {
				setStatus("Search failed. Check the connection, or pick a preset.");
			}
		},
		[pick],
	);

	useEffect(() => {
		pick(PRESETS[0]);
	}, [pick]);

	return { area, satellite: satellite?.id === area?.id ? (satellite?.canvas ?? null) : null, status, pick, search };
}
