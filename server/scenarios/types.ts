import type { CellState, ScenarioId, Task, Vec } from "../../shared/types";
import type { ServerAgent, World } from "../world";

export interface ScenarioMetrics {
    edgeMappedPct: number;
}

/** Pluggable scenario: the world calls these every tick. */
export interface Scenario {
    id: ScenarioId;
    init(world: World): void;
    step(world: World): void;
    /** Ground-truth cell under (x, y), or "unknown" off-grid. */
    cell(x: number, y: number): CellState;
    /** Full ground-truth grid for the viewer (row-major). */
    cells(): CellState[];
    tasksFor(agent: ServerAgent, world: World): Task[];
    metrics(world: World): ScenarioMetrics;
    /** Where a newly joined agent appears. */
    spawn(agent: { isPhone: boolean; index: number }, world: World): Vec;
}
