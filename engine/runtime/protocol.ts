import type { AgentId } from "../../shared/types";
import type { BrainKind } from "../brains";
import type { AgentStatus } from "./connection";

/** Main thread -> worker. */
export type WorkerCommand =
    | { type: "start"; url: string; id: AgentId; isPhone: boolean; brain: BrainKind; width?: number; height?: number; seed?: number }
    | { type: "stop" };

/** Worker -> main thread. */
export type WorkerEvent = { type: "status"; status: AgentStatus };
