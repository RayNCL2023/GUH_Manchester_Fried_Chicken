# /ai: Claude layer (Ray)

- `parseGoal(transcript, brief)` turns a spoken order into a `GoalBody` using Claude (`claude-opus-5-5`, low effort, structured output, 4 s timeout). It falls back to a keyword parser when there's no key, an error, a timeout or a refusal.
- `sitrep(brief)` produces a two-sentence radio summary, falling back to a template.

The server mounts both, at `/ai/goal` and `/ai/sitrep`. Agents never call Claude: a goal is injected into one drone and spreads by gossip.
