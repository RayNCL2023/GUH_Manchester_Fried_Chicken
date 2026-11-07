import { metaGen } from "nitlix-metagen";
import HostClient from "@/components/(hive)/HostClient";

export const metadata = metaGen({
    title: "Hive · Agent host",
    description: "Launch independent drone agents from this laptop.",
});

export default async function () {
    return <HostClient />;
}
