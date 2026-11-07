"use client";

// A judge's phone becomes one drone: it runs its own HiveBrain in a Web Worker and talks to the
// world server like every other agent. In the light show it turns into one pixel of the picture.
import { useEffect, useRef, useState } from "react";
import { startPhoneAgent, type AgentStatus, type PhoneAgent } from "@mfc/engine/runtime";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import { serverUrl } from "@/lib/hive/server";

const STATE_TEXT: Record<string, string> = {
    normal: "In formation",
    relay: "Relaying for the flock",
    isolated: "Out of contact · working alone",
};

export default function () {
    const [url, setUrl] = useState<string | null>(null);
    const [agent, setAgent] = useState<PhoneAgent | null>(null);
    const [status, setStatus] = useState<AgentStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const wasJammed = useRef(false);

    useEffect(() => setUrl(serverUrl()), []);
    useEffect(() => () => agent?.stop(), [agent]);

    useEffect(() => {
        if (!status) {
            return;
        }
        // A short buzz when this phone loses the radio: the outage is felt, not just seen.
        if (status.jammed && !wasJammed.current && "vibrate" in navigator) {
            navigator.vibrate?.(180);
        }
        wasJammed.current = status.jammed;
    }, [status]);

    const join = async () => {
        if (!url) {
            setError("No server set. Scan the QR code on the big screen.");
            return;
        }
        try {
            setAgent(await startPhoneAgent({ url, onStatus: setStatus }));
            document.documentElement.requestFullscreen?.().catch(() => {});
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    if (agent && status?.scenario === "lights") {
        const color = status.alive ? (status.color ?? "#000000") : "#000000";
        return (
            <div
                className="fixed inset-0 flex flex-col items-center justify-end p-[1.5rem] transition-colors duration-300"
                style={{ background: color }}
                onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}
            >
                <p className="text-[.875rem] text-white/40 mix-blend-difference">{agent.id} · hold your phone up</p>
            </div>
        );
    }

    if (agent) {
        const mode = !status ? "Connecting…" : !status.connected ? "Reconnecting…" : !status.alive ? "Shot down" : status.jammed ? "Jammed · flying on last plan" : (STATE_TEXT[status.mode] ?? status.mode);
        const tone = !status?.alive ? "text-mute" : status.jammed || status.mode === "isolated" ? "text-amber-300" : "text-flock";
        return (
            <div className="flex flex-col justify-between min-h-screen p-[1.5rem] bg-ink text-white">
                <p className="text-[.875rem] text-mute">Hive · you are a drone</p>
                <div className="flex flex-col gap-[1rem]">
                    <p className="text-[1rem] text-mute">Callsign</p>
                    <p className="font-display text-[4rem] leading-none tracking-[-0.04em]">{agent.id}</p>
                    <p className={`text-[1.25rem] ${tone}`}>{mode}</p>
                    {status?.claim && <p className="text-[1rem] text-mute">Task: {status.claim.replace(/:/g, " ")}</p>}
                    <p className="text-[1rem] text-mute tabular-nums">Map known: {Math.round(status?.knownPct ?? 0)}%</p>
                </div>
                <p className="text-[.875rem] leading-relaxed text-mute">
                    Your phone runs its own brain. It only hears drones within radio range, and nobody is in charge. Keep this page open.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col justify-between min-h-screen p-[1.5rem] gap-[2rem] bg-ink text-white">
            <p className="text-[.875rem] text-mute">Hive</p>
            <div className="flex flex-col gap-[1rem]">
                <h1 className="font-display text-[3rem] leading-[1.05] tracking-[-0.03em] text-balance">Join the flock.</h1>
                <p className="text-[1rem] leading-relaxed text-mute text-pretty">
                    Your phone becomes one drone in a swarm with no leader. When the picture forms, it lights up as one pixel.
                </p>
            </div>
            <div className="flex flex-col gap-[.75rem]">
                <ButtonBase onClick={join} className="min-h-[4rem] text-[1.25rem] bg-flock border-flock text-ink">
                    Become a drone
                </ButtonBase>
                {error && <p className="text-[1rem] text-amber-300">{error}</p>}
            </div>
        </div>
    );
}
