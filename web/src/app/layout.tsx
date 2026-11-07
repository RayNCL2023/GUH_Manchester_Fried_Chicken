// =====================
// Global CSS Imports
// =====================
import "./globals.css";
import "./animations.scss";

// =====================
// Theme CSS Imports
// =====================
import "@/backbone/themes.scss";

// =====================
// Google Font (Inter)
// =====================
// import { Inter } from "next/font/google";
// const inter = Inter({ subsets: ["latin"] });

// =====================
// Geist Font (By Vercel)
// =====================
import NeueMontreal from "@/fonts/NeueMontreal/NeueMontreal";
import { NitlixOne } from "@/fonts/NitlixOne/NitlixOne";

// =====================
// Custom Font (Neue Montreal)
// =====================

// =====================
// Metadata Export
// =====================
import { metaGen, setDefaults } from "nitlix-metagen";
setDefaults({
    title: "Hive",
    description:
        "Keep the flock flying when the link drops.",
});
export const metadata = metaGen();

// =====================
// Theme Provider
// =====================
import Backbone from "@/backbone/Backbone";
import Aos from "@/lib/Aos/Aos";
import { ThemeProvider } from "next-themes";
// =====================
// Layout Export
// =====================
export default async function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" suppressHydrationWarning>
            <Backbone className={`${NeueMontreal.className} ${NeueMontreal.variable} ${NitlixOne.variable}`}>
                {/* Feel free to remove the code below if you don't wish to use AOS */}
                <Aos />
                <ThemeProvider forcedTheme="dark">
                    <main className="_nitlix" data-scroll-container>
                        {children}
                    </main>
                </ThemeProvider>
            </Backbone>
        </html>
    );
}
