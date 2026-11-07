import type { AgentBrain } from "../shared/types";
import { HiveBrain, type HiveOptions } from "./brain";
import { RandomWalkBrain } from "./randomWalkBrain";

export type BrainKind = "hive" | "random";

export function createBrain(kind: BrainKind = "hive", opts: HiveOptions = {}): AgentBrain {
    if (kind === "random") {
        return new RandomWalkBrain(opts);
    }
    return new HiveBrain(opts);
}
