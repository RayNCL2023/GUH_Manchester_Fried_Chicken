import TopBar from "./TopBar";
import UplinkConsole from "./UplinkConsole";

// Standalone /uplink/send page: the same console as the demo's Sound uplink tab.
export default function () {
	return (
		<div className="flex flex-col min-h-screen bg-ink text-white">
			<TopBar crumbs={["Sound uplink"]} />
			<UplinkConsole />
		</div>
	);
}
