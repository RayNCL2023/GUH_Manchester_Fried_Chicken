import localFont from "next/font/local";

export const NitlixOne = localFont({
    src: [
        { path: "./NitlixOne-Regular.woff2", weight: "400", style: "normal" },
        { path: "./NitlixOne-Medium.woff2", weight: "500", style: "normal" },
        { path: "./NitlixOne-Semibold.woff2", weight: "600", style: "normal" },
    ],
    variable: "--font-nitlix-one",
    display: "swap",
});
