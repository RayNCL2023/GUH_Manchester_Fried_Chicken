"use client";

// Laptop agent host: 8 drones, each its own Web Worker with its own brain and socket.
import { useEffect, useRef, useState } from "react";
import { spawnAgentHost, type AgentHost, type AgentStatus } from "@mfc/engine/runtime";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import { serverUrl } from "@/lib/hive/server";
import TopBar from "./TopBar";

export default function () {
    const [url, setUrl] = useState<string | null>(null);
    const [count, setCount] = useState(8);
    const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
    const host = useRef<AgentHost | null>(null);
    const [running, setRunning] = useState(false);

    useEffect(() => {
        setUrl(serverUrl());
        return () => host.current?.stop();
    }, []);

    const start = () => {
        if (!url) {
            return;
        }
        host.current?.stop();
        setStatuses({});
        host.current = spawnAgentHost({ url, count, onStatus: (s) => setStatuses((m) => ({ ...m, [s.id]: s })) });
        setRunning(true);
    };

    const stop = () => {
        host.current?.stop();
        host.current = null;
        setRunning(false);
    };

    const rows = Object.values(statuses).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    return (
        <div className="flex flex-col min-h-screen bg-ink text-white">
            <TopBar crumbs={["Agent host"]} />
            <div className="flex flex-col gap-[1.5rem] p-[1.25rem] max-w-[48rem]">
                <p className="text-[1rem] leading-relaxed text-mute text-pretty">
                    Each drone runs in its own Web Worker with its own brain and its own connection. They never share memory; they only hear what the simulated radio delivers.
                </p>
                {!url && <p className="text-[1rem] text-amber-300">No server set. Open this page with ?server=your-server-host</p>}
                <div className="flex flex-row flex-wrap items-center gap-[.5rem]">
                    <label className="flex flex-row items-center gap-[.75rem] min-h-[2.75rem] px-[1rem] border border-line text-[.875rem] text-mute">
                        Drones
                        <input type="number" min={1} max={24} value={count} onChange={(e) => setCount(Number(e.target.value))} className="w-[4rem] bg-transparent text-white text-[1rem]" />
                    </label>
                    <ButtonBase onClick={start} disabled={!url} className="border-flock text-flock">
                        {running ? "Relaunch" : "Launch drones"}
                    </ButtonBase>
                    {running && <ButtonBase onClick={stop}>Land all</ButtonBase>}
                </div>
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-[1.5rem] gap-y-[.4rem] text-[.875rem] tabular-nums">
                    <span className="text-mute">Callsign</span>
                    <span className="text-mute">Link</span>
                    <span className="text-mute">Mode</span>
                    <span className="text-mute text-right">Map known</span>
                    {rows.map((s) => (
                        <div key={s.id} className="contents">
                            <span>{s.id}</span>
                            <span className={s.connected ? "text-flock" : "text-mute"}>{s.connected ? "up" : "down"}</span>
                            <span>{!s.alive ? "down" : s.jammed ? "jammed" : s.mode}</span>
                            <span className="text-right">{Math.round(s.knownPct)}%</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
