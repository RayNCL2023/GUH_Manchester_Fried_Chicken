"use client";

import { useState } from "react";
import ButtonBase from "@/components/(buttons)/ButtonBase";
import type { GoalBody, WorldView } from "../../../../shared/types";
import useRadio from "@/lib/hive/useRadio";

// Voice controls: radio on/off, hold-to-talk orders, typed orders, spoken sitrep.
export default function ({
    getView,
    http,
    injectGoal,
}: {
    getView: () => WorldView | null;
    http: string | null;
    injectGoal: (g: GoalBody) => void;
}) {
    const r = useRadio({ getView, http, injectGoal });
    const [typed, setTyped] = useState("");
    const s = r.state;

    return (
        <div className="flex flex-col gap-[.75rem]">
            <div className="flex flex-row flex-wrap items-center gap-[.5rem]">
                {!s.enabled ? (
                    <ButtonBase onClick={r.enable} className="border-flock text-flock">
                        Turn on radio audio
                    </ButtonBase>
                ) : (
                    <>
                        <ButtonBase onClick={r.toggleMute}>{s.muted ? "Unmute" : "Mute"}</ButtonBase>
                        <ButtonBase onClick={r.toggleCritical} data-on={s.criticalOnly} className="data-[on=true]:border-flock">
                            Critical only
                        </ButtonBase>
                    </>
                )}
                <ButtonBase
                    onPointerDown={r.startTalk}
                    onPointerUp={r.stopTalk}
                    onPointerLeave={() => s.talking && r.stopTalk()}
                    data-on={s.talking}
                    className="select-none touch-none data-[on=true]:bg-fire data-[on=true]:border-fire"
                >
                    {s.talking ? "Listening… release to send" : "Hold to give an order"}
                </ButtonBase>
                <ButtonBase onClick={r.sitrep} disabled={s.busy}>
                    Sitrep
                </ButtonBase>
            </div>
            <form
                className="flex flex-row gap-[.5rem]"
                onSubmit={(e) => {
                    e.preventDefault();
                    void r.typeOrder(typed);
                    setTyped("");
                }}
            >
                <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="Or type an order: “cover the north flank”"
                    className="flex-1 min-h-[2.75rem] px-[1rem] bg-panel border border-line text-white text-[1rem] placeholder:text-mute"
                />
                <ButtonBase type="submit" disabled={s.busy}>
                    Send
                </ButtonBase>
            </form>
            <p className="text-[.875rem] leading-relaxed text-mute min-h-[1.5rem]">
                {s.speaking ? <span className="text-flock">● {s.speaking} on air · </span> : null}
                {s.lastOrder ?? (http ? "Orders go to one drone and spread by gossip." : "Offline: orders use browser speech + keyword parsing.")}
            </p>
        </div>
    );
}
