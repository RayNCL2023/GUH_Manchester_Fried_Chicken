import { metaGen } from "nitlix-metagen";
import Demo from "@/components/(hive)/Demo";

export const metadata = metaGen({
	title: "Hive · Live demo",
	description: "Keep the flock flying when the link drops.",
});

export default async function () {
	return <Demo />;
}
