// The 4 radio voices. Folder name -> ElevenLabs voice id.
// Swap ids for any voices in your ElevenLabs library (Voice Library -> copy ID). Calm, clear voices work best.
// Override at generation time with HIVE_VOICES="name:id,name:id,...".
export interface RadioVoice {
    name: string;
    voiceId: string;
}

export const DEFAULT_VOICES: RadioVoice[] = [
    { name: "alpha", voiceId: "onwK4e9ZLuTAKqWW03F9" }, // Daniel: steady broadcaster (British)
    { name: "bravo", voiceId: "Xb7hH8MSUJpSbSDYk0k2" }, // Alice: clear (British)
    { name: "charlie", voiceId: "SAz9YHcvj6GT2YYXdXww" }, // River: relaxed, neutral
    { name: "delta", voiceId: "nPczCjzI2devNBz1zQrb" }, // Brian: deep, comforting
];

export function voicesFromEnv(env: string | undefined): RadioVoice[] {
    if (!env) {
        return DEFAULT_VOICES;
    }
    return env
        .split(",")
        .map((pair) => pair.split(":"))
        .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
        .map(([name, voiceId]) => ({ name: name.trim(), voiceId: voiceId.trim() }));
}

/** Stable agent -> voice index (same agent always sounds the same). */
export function voiceIndexFor(agentId: string, count: number): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < agentId.length; i++) {
        h ^= agentId.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % Math.max(count, 1);
}
