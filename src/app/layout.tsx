import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AppHeader } from "@/components/AppHeader";

const inter = localFont({ src: "../../assets/fonts/Inter.ttf", variable: "--font-inter", display: "swap" });
const playfair = localFont({ src: "../../assets/fonts/PlayfairDisplay.ttf", variable: "--font-playfair", display: "swap" });

const appName = process.env.NEXT_PUBLIC_APP_NAME || "ReelCraft AI";

export const metadata: Metadata = {
  title: { default: appName, template: `%s · ${appName}` },
  description: "Give us your idea and your media. ReelCraft plans, edits, reviews, and renders your video.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable}`}>
      <body className="font-sans antialiased">
        <AppHeader appName={appName} />
        <main className="mx-auto w-full max-w-7xl px-4 pb-24 pt-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
