// Benchmark: Hive vs a (generous) centralised controller as comms degrade. Data from
// engine/sim/benchmark.ts -> engine/sim/results.json (regenerate, rebuild, it updates here).
import results from "@mfc/engine/results";
import PanelBase from "./PanelBase";

type Row = { scenario: string; results: { hive: number; central: number } };

export default function () {
    const rows = (results as { rows: Row[] }).rows;
    return (
        <PanelBase
            index="05"
            title="When the link fails · % of fire edge mapped (8 drones, 3 seeds)"
            aside={
                <span className="flex flex-row gap-[1rem] text-[.875rem] text-mute">
                    <span className="flex flex-row items-center gap-[.4rem]">
                        <span className="size-[.6rem] bg-flock" />
                        Hive (leaderless)
                    </span>
                    <span className="flex flex-row items-center gap-[.4rem]">
                        <span className="size-[.6rem] bg-mute" />
                        Central controller with perfect info
                    </span>
                </span>
            }
            className="border-b"
        >
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-[1.25rem]">
                {rows.map((r) => (
                    <div key={r.scenario} className="flex flex-col gap-[.4rem]">
                        <p className="text-[.875rem] text-white">{r.scenario}</p>
                        <Bar value={r.results.hive} className="bg-flock" />
                        <Bar value={r.results.central} className="bg-mute" />
                    </div>
                ))}
            </div>
        </PanelBase>
    );
}

function Bar({ value, className }: { value: number; className: string }) {
    return (
        <div className="flex flex-row items-center gap-[.5rem]">
            <div className="flex-1 h-[.5rem] bg-panel">
                <div className={`h-full ${className}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
            </div>
            <span className="w-[3rem] text-right text-[.875rem] tabular-nums text-white">{Math.round(value)}%</span>
        </div>
    );
}
