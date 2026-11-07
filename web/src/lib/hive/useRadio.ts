"use client";

// Voice for the viewer: radio chatter playback, push-to-talk goals, spoken sitrep.
// Server mode: ElevenLabs STT -> Claude goal -> live ElevenLabs reply.
// Offline mode: browser speech recognition -> keyword goal -> injected into the local sim.
import { useCallback, useEffect, useRef, useState } from "react";
import { keywordGoal } from "@mfc/ai/keywords";
import { PushToTalk, RadioPlayer } from "@mfc/voice";
import type { GoalBody, WorldView } from "../../../../shared/types";

type SR = { start(): void; stop(): void; onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; lang: string; interimResults: boolean };

export interface RadioState {
    enabled: boolean;
    muted: boolean;
    criticalOnly: boolean;
    talking: boolean;
    speaking: string | null;
    lastOrder: string | null;
    busy: boolean;
}

export default function useRadio(opts: {
    getView: () => WorldView | null;
    http: string | null;
    injectGoal: (g: GoalBody) => void;
}) {
    const radio = useRef<RadioPlayer | null>(null);
    const ptt = useRef<PushToTalk | null>(null);
    const rec = useRef<SR | null>(null);
    const heard = useRef("");
    const [state, setState] = useState<RadioState>({ enabled: false, muted: false, criticalOnly: false, talking: false, speaking: null, lastOrder: null, busy: false });
    const set = (p: Partial<RadioState>) => setState((s) => ({ ...s, ...p }));
    const { getView, http, injectGoal } = opts;

    useEffect(() => {
        const r = new RadioPlayer({ audioBase: "/audio", onSpeaking: (id) => set({ speaking: id }) });
        radio.current = r;
        ptt.current = http ? new PushToTalk({ serverHttp: http, radio: r }) : null;
        const id = setInterval(() => {
            const v = getView();
            if (v) {
                r.update(v);
            }
        }, 100);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [http]);

    const enable = useCallback(async () => {
        await radio.current?.unlock();
        set({ enabled: true });
    }, []);

    const toggleMute = useCallback(() => {
        setState((s) => {
            radio.current?.setMuted(!s.muted);
            return { ...s, muted: !s.muted };
        });
    }, []);

    const toggleCritical = useCallback(() => {
        setState((s) => {
            radio.current?.setCriticalOnly(!s.criticalOnly);
            return { ...s, criticalOnly: !s.criticalOnly };
        });
    }, []);

    const offlineGoal = useCallback(
        (text: string) => {
            const v = getView();
            if (!v) {
                return;
            }
            let vx = 0, vy = 0, vn = 0, fx = 0, fy = 0, fn = 0;
            v.cells.forEach((c, i) => {
                const x = i % v.width;
                const y = Math.floor(i / v.width);
                if (c === "village") { vx += x; vy += y; vn++; }
                if (c === "fire") { fx += x; fy += y; fn++; }
            });
            const g = keywordGoal(`goal-voice-${Date.now()}`, text, {
                width: v.width,
                height: v.height,
                village: vn ? { x: vx / vn, y: vy / vn } : null,
                fireCentre: fn ? { x: fx / fn, y: fy / fn } : null,
                text: "",
            });
            const { source: _s, ...body } = g;
            injectGoal(body);
            set({ lastOrder: `${body.text} (keywords, offline)` });
        },
        [getView, injectGoal],
    );

    const startTalk = useCallback(async () => {
        await enable();
        set({ talking: true });
        if (ptt.current) {
            try {
                await ptt.current.start();
                return;
            } catch {
                // mic blocked: fall through to browser recognition
            }
        }
        const Ctor = (window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }).SpeechRecognition
            ?? (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition;
        if (!Ctor) {
            set({ talking: false, lastOrder: "No microphone speech support in this browser" });
            return;
        }
        heard.current = "";
        const r = new Ctor();
        r.lang = "en-GB";
        r.interimResults = false;
        r.onresult = (e) => {
            heard.current = Array.from(e.results).map((x) => x[0].transcript).join(" ");
        };
        r.onend = () => {
            if (heard.current) {
                offlineGoal(heard.current);
            }
        };
        r.onerror = () => {};
        rec.current = r;
        r.start();
    }, [enable, offlineGoal]);

    const stopTalk = useCallback(async () => {
        set({ talking: false });
        if (rec.current) {
            rec.current.stop();
            rec.current = null;
            return;
        }
        if (!ptt.current?.recording) {
            return;
        }
        set({ busy: true });
        const res = await ptt.current.stop();
        set({ busy: false, lastOrder: res.goal ? `“${res.transcript}” → ${res.goal.text} (${res.source}, first heard by ${res.firstHop})` : `Didn't catch that${res.error ? `: ${res.error}` : ""}` });
    }, []);

    /** Typed order: same pipeline, no microphone (rehearsal / noisy venue). */
    const typeOrder = useCallback(
        async (text: string) => {
            if (!text.trim()) {
                return;
            }
            if (!ptt.current) {
                offlineGoal(text);
                return;
            }
            set({ busy: true });
            try {
                const res = await ptt.current.sendGoal(text);
                set({ lastOrder: res.goal ? `${res.goal.text} (${res.source}, first heard by ${res.firstHop})` : "No goal" });
            } catch {
                offlineGoal(text);
            } finally {
                set({ busy: false });
            }
        },
        [offlineGoal],
    );

    const sitrep = useCallback(async () => {
        await enable();
        if (!ptt.current) {
            const v = getView();
            const txt = v ? `${v.metrics.aliveAgents} drones up. Fire edge ${Math.round(v.metrics.edgeMappedPct)} percent mapped.` : "No data.";
            if (typeof speechSynthesis !== "undefined") {
                speechSynthesis.speak(new SpeechSynthesisUtterance(txt));
            }
            set({ lastOrder: `Sitrep: ${txt}` });
            return;
        }
        set({ busy: true });
        try {
            const text = await ptt.current.sitrep();
            set({ lastOrder: `Sitrep: ${text}` });
        } finally {
            set({ busy: false });
        }
    }, [enable, getView]);

    return { state, enable, toggleMute, toggleCritical, startTalk, stopTalk, typeOrder, sitrep };
}
