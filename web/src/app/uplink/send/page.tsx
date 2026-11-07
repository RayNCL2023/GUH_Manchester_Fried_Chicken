import { metaGen } from "nitlix-metagen";
import UplinkHost from "@/components/(hive)/UplinkHost";

export const metadata = metaGen({
    title: "Hive · Send Mission Uplink",
    description: "Broadcast a fountain-coded mission package through the laptop speaker.",
});

export default async function () {
    return <UplinkHost />;
}
