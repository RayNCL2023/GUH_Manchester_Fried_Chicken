import { metaGen } from "nitlix-metagen";
import JoinClient from "@/components/(hive)/JoinClient";

export const metadata = metaGen({
    title: "Hive · Join the flock",
    description: "Your phone becomes one drone in a leaderless swarm.",
});

export default async function () {
    return <JoinClient />;
}
