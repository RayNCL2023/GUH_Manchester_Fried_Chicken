import { metaGen } from "nitlix-metagen";
import UplinkPhone from "@/components/(hive)/UplinkPhone";

export const metadata = metaGen({
    title: "Hive · Mission Uplink",
    description: "New orders over sound: no network, just the laptop speaker.",
});

export default async function () {
    return <UplinkPhone />;
}
