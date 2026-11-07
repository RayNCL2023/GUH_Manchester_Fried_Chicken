import { metaGen } from "nitlix-metagen";
import JoinClient from "@/components/(hive)/JoinClient";

export const metadata = metaGen({
    title: "Hive · Light show",
    description: "Hold your phone up: you're one pixel of the picture.",
});

// Same agent page: it turns full-screen colour whenever the server runs the light show.
export default async function () {
    return <JoinClient />;
}
