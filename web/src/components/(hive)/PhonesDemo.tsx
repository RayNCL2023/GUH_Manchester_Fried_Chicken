"use client";

// The real light show: every pixel is a judge's phone (its own brain, its own socket).
// The server turns the Hive logo into N slot tasks; phones claim them leaderlessly.
// Phones leave -> the grid rebuilds at lower resolution and the picture re-forms.
import { Fragment, useEffect, useRef, useState } from "react";
import type { WorldView } from "../../../../shared/types";
import { C } from "@/lib/hive/pixel";
import { ViewerSocket, httpBase, serverUrl } from "@/lib/hive/server";
import type { Chatter } from "@/lib/hive/types";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import DemoLayout from "./DemoLayout";
import VoiceBar from "./VoiceBar";

export default function () {
    const [view, setView] = useState<WorldView | null>(null);
    const [history, setHistory] = useState<number[]>([]);
    const sock = useRef<ViewerSocket | null>(null);
    const canvas = useRef<HTMLCanvasElement | null>(null);
    const viewRef = useRef<WorldView | null>(null);

    useEffect(() => {
        const url = serverUrl();
        if (!url) {
            return;
        }
        let lastHist = -1;
        const s = new ViewerSocket(url, (v) => {
            viewRef.current = v;
            setView(v);
            if (v.tick % 5 === 0 && v.tick !== lastHist) {
                lastHist = v.tick;
                setHistory((h) => [...h.slice(-149), Math.round(v.metrics.edgeMappedPct)]);
            }
        });
        sock.current = s;
        const t = setInterval(() => {
            if (s.view && s.view.scenario !== "lights") {
                s.control({ type: "switchScenario", scenario: "lights" });
            }
        }, 1000);
        return () => {
            clearInterval(t);
            s.close();
        };
    }, []);

    useEffect(() => {
        const cv = canvas.current;
        if (!cv || !view) {
            return;
        }
        const ctx = cv.getContext("2d")!;
        const W = cv.width;
        const H = cv.height;
        ctx.fillStyle = C.ink;
        ctx.fillRect(0, 0, W, H);
        const sx = W / view.width;
        const sy = H / view.height;
        const size = Math.max(10, Math.min(sx, sy) * 3.2);
        for (const a of view.agents) {
            const x = a.pos.x * sx;
            const y = a.pos.y * sy;
            ctx.fillStyle = !a.alive ? C.dead : a.color && a.color !== "#000000" ? a.color : C.panel;
            ctx.fillRect(x - size / 2, y - size / 2, size, size);
            if (a.jammed) {
                ctx.strokeStyle = C.mute;
                ctx.strokeRect(x - size / 2 + 1, y - size / 2 + 1, size - 2, size - 2);
            }
        }
        ctx.strokeStyle = C.line;
        for (const [a, b] of view.links) {
            const pa = view.agents.find((x) => x.id === a);
            const pb = view.agents.find((x) => x.id === b);
            if (!pa || !pb) {
                continue;
            }
            ctx.globalAlpha = 0.25;
            ctx.beginPath();
            ctx.moveTo(pa.pos.x * sx, pa.pos.y * sy);
            ctx.lineTo(pb.pos.x * sx, pb.pos.y * sy);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
    }, [view]);

    if (!serverUrl()) {
        return <p className="p-[1.25rem] text-[1rem] text-mute">The phone light show needs the live server. Open this page with ?server=your-server-host.</p>;
    }
    if (!view) {
        return <p className="p-[1.25rem] text-[1rem] text-mute">Connecting to the flock…</p>;
    }

    const phones = view.agents.filter((a) => a.isPhone);
    const lit = view.agents.filter((a) => a.alive && a.color && a.color !== "#000000").length;
    const chatter: Chatter[] = view.recentChatter.slice(-8).reverse();
    const http = httpBase(serverUrl()!);

    return (
        <DemoLayout
            title={<span className="text-flock">● Live · every pixel is a phone</span>}
            canvas={<canvas ref={canvas} width={960} height={640} className="w-full max-h-[calc(100vh-13rem)] object-contain bg-ink" />}
            controls={
                <>
                    <ButtonBase onClick={() => sock.current?.control({ type: "clearJams" })}>Clear jams</ButtonBase>
                    <ButtonBase onClick={() => sock.current?.control({ type: "addJam", center: { x: 30, y: 20 }, radius: 8 })}>Jam the centre</ButtonBase>
                    <ButtonBase onClick={() => sock.current?.control({ type: "reset" })}>Reset</ButtonBase>
                    <p className="text-[.875rem] text-mute xl:ml-auto">Ask a few judges to lock their phones: the picture re-forms.</p>
                    <div className="w-full pt-[.5rem]">
                        <VoiceBar getView={() => viewRef.current} http={http} injectGoal={(body) => sock.current?.control({ type: "goal", body })} />
                    </div>
                </>
            }
            headline={{ label: "Picture formed", value: Math.round(view.metrics.edgeMappedPct) }}
            history={history}
            sideTitle="Phones"
            side={
                <div className="grid grid-cols-[1fr_auto] gap-x-[1.5rem] gap-y-[.4rem] text-[.875rem] tabular-nums">
                    <span className="text-mute">Callsign</span>
                    <span className="text-mute">Pixel</span>
                    {phones.length === 0 && <span className="text-mute">Scan the QR code to join.</span>}
                    {phones.map((a) => (
                        <Fragment key={a.id}>
                            <span>{a.id}</span>
                            <span className="flex flex-row items-center gap-[.4rem]">
                                <span className="size-[.6rem]" style={{ background: a.color ?? C.panel }} />
                                {a.claim?.replace("slot:", "") ?? "—"}
                            </span>
                        </Fragment>
                    ))}
                </div>
            }
            chatter={chatter}
            stats={[
                { label: "Phones", value: phones.length },
                { label: "Agents", value: view.agents.length },
                { label: "Pixels lit", value: lit },
                { label: "Radio links", value: view.links.length },
            ]}
        />
    );
}
