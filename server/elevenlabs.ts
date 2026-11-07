// Server-side ElevenLabs proxies so the API key never reaches a browser.
const BASE = "https://api.elevenlabs.io/v1";

function key(): string | null {
    return process.env.ELEVENLABS_API_KEY || null;
}

export function elevenLabsConfigured(): boolean {
    return key() !== null;
}

/** Speech-to-text: forwards the recorded clip, returns the transcript. */
export async function speechToText(audio: Blob, filename = "ptt.webm"): Promise<string> {
    const k = key();
    if (!k) {
        throw new Error("ELEVENLABS_API_KEY not set");
    }
    const form = new FormData();
    form.append("model_id", "scribe_v1");
    form.append("file", audio, filename);
    const res = await fetch(`${BASE}/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": k },
        body: form,
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
}

/** Text-to-speech: returns MP3 bytes. Calm, stable delivery by default (radio voices shouldn't shout). */
export async function textToSpeech(text: string, voiceId: string): Promise<ArrayBuffer> {
    const k = key();
    if (!k) {
        throw new Error("ELEVENLABS_API_KEY not set");
    }
    const res = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": k, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({
            text: text.slice(0, 400),
            model_id: "eleven_flash_v2_5",
            voice_settings: { stability: 0.7, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
        }),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.arrayBuffer();
}

/** Sound effects (used by voice/generate.ts for static and squelch). */
export async function soundEffect(prompt: string, seconds: number): Promise<ArrayBuffer> {
    const k = key();
    if (!k) {
        throw new Error("ELEVENLABS_API_KEY not set");
    }
    const res = await fetch(`${BASE}/sound-generation`, {
        method: "POST",
        headers: { "xi-api-key": k, "content-type": "application/json" },
        body: JSON.stringify({ text: prompt, duration_seconds: seconds, prompt_influence: 0.6 }),
        signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
        throw new Error(`ElevenLabs SFX ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.arrayBuffer();
}
