// Push-to-talk voice command + spoken sitrep. Browser only.
//   const ptt = new PushToTalk({ serverHttp: "https://<server>", radio });
//   button.onpointerdown = () => ptt.start();  button.onpointerup = async () => show(await ptt.stop());
import type { GoalBody } from "../shared/types";
import type { RadioPlayer } from "./radio";
import { DEFAULT_VOICES, voiceIndexFor } from "./voices";

export interface PttOptions {
    /** HTTP origin of the world server, e.g. https://hive.up.railway.app (default: same origin). */
    serverHttp?: string;
    radio: RadioPlayer;
    /** Voice ids for live replies, same order as RadioPlayer voices. */
    voiceIds?: string[];
}

export interface PttResult {
    transcript: string;
    goal: GoalBody | null;
    source?: "llm" | "keywords";
    firstHop?: string | null;
    error?: string;
}

export class PushToTalk {
    private rec: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private stream: MediaStream | null = null;
    private readonly base: string;
    private readonly voiceIds: string[];

    constructor(private readonly opts: PttOptions) {
        this.base = (opts.serverHttp ?? "").replace(/\/$/, "");
        this.voiceIds = opts.voiceIds ?? DEFAULT_VOICES.map((v) => v.voiceId);
    }

    get recording(): boolean {
        return this.rec?.state === "recording";
    }

    async start(): Promise<void> {
        if (this.recording) {
            return;
        }
        await this.opts.radio.unlock();
        this.opts.radio.duck("ptt");
        this.stream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        this.chunks = [];
        this.rec = new MediaRecorder(this.stream);
        this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
        this.rec.start();
    }

    /** Stops recording, transcribes, sends the goal, plays the first drone's spoken acknowledgement. */
    async stop(): Promise<PttResult> {
        const rec = this.rec;
        if (!rec || rec.state !== "recording") {
            this.opts.radio.duck(null);
            return { transcript: "", goal: null, error: "not recording" };
        }
        const blob = await new Promise<Blob>((resolve) => {
            rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || "audio/webm" }));
            rec.stop();
        });
        this.opts.radio.duck(null);
        try {
            const transcript = await this.transcribe(blob);
            if (!transcript) {
                return { transcript, goal: null, error: "heard nothing" };
            }
            return await this.sendGoal(transcript);
        } catch (err) {
            return { transcript: "", goal: null, error: err instanceof Error ? err.message : String(err) };
        }
    }

    /** Typed fallback: same pipeline without the microphone (also great for rehearsal). */
    async sendGoal(transcript: string): Promise<PttResult> {
        const res = await fetch(`${this.base}/ai/goal`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ transcript }),
        });
        const data = (await res.json()) as { goal: GoalBody; source: "llm" | "keywords"; firstHop: string | null };
        if (data.firstHop) {
            void this.acknowledge(data.firstHop, data.goal);
        }
        return { transcript, goal: data.goal, source: data.source, firstHop: data.firstHop };
    }

    private async transcribe(blob: Blob): Promise<string> {
        const form = new FormData();
        form.append("file", blob, "ptt.webm");
        const res = await fetch(`${this.base}/stt`, { method: "POST", body: form });
        const data = (await res.json()) as { text?: string; error?: string };
        if (!res.ok) {
            throw new Error(data.error ?? `stt ${res.status}`);
        }
        return data.text ?? "";
    }

    /** The drone that first heard the order replies live, in its own voice; cached "copy" clip if TTS fails. */
    private async acknowledge(agentId: string, goal: GoalBody): Promise<void> {
        const radio = this.opts.radio;
        const voiceId = this.voiceIds[voiceIndexFor(agentId, this.voiceIds.length)];
        const callsign = agentId.replace("-", " ");
        try {
            const res = await fetch(`${this.base}/tts`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: `${callsign} copies. ${goal.text}. Passing it on.`, voiceId }),
            });
            const buf = res.ok ? await radio.decode(await res.arrayBuffer()) : null;
            if (buf) {
                await radio.playBuffer(buf);
                return;
            }
        } catch {
            // fall through to cached clip
        }
        await radio.playClip(agentId, "goal_copy", 0);
    }

    /** Spoken situation report (Claude summary -> ElevenLabs), chatter ducked underneath. */
    async sitrep(): Promise<string> {
        const radio = this.opts.radio;
        await radio.unlock();
        const { text } = (await (await fetch(`${this.base}/ai/sitrep`)).json()) as { text: string };
        radio.duck("sitrep");
        try {
            const res = await fetch(`${this.base}/tts`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text, voiceId: this.voiceIds[0] }),
            });
            const buf = res.ok ? await radio.decode(await res.arrayBuffer()) : null;
            if (buf) {
                await radio.playBuffer(buf, { radio: false });
            } else if (typeof speechSynthesis !== "undefined") {
                speechSynthesis.speak(new SpeechSynthesisUtterance(text));
            }
        } finally {
            radio.duck(null);
        }
        return text;
    }
}
