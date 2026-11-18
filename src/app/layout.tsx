import type { Metadata } from "next";
import { io } from "next/cache";
import { Geist_Mono, Inter } from "next/font/google";
import { Suspense } from "react";
import { getLocale, t } from "@/lib/i18n";
import { DesktopChrome } from "./desktop-chrome";
import { InlineScript } from "./inline-script";
import "./globals.css";

// The UI face is San Francisco where the system has it (globals.css); Inter stands in everywhere else,
// with its optical-size axis so large titles get the display cut.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  axes: ["opsz"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  await io();
  return { title: "VideoGen", description: t("Short videos with AI narration, subtitles, and motion graphics.") };
}

// The document language depends on the local settings at request time.
export const instant = false;

/**
 * Applies the theme chosen in Settings before the first paint (no flash). A device preference, so it lives in
 * the browser: the desktop window follows the system unless told otherwise, the browser starts light.
 * The same goes for the width the user gave the studio's side panel (side-resizer.tsx): it is there from
 * the first frame, so the studio does not open at one width and jump to another.
 */
const THEME_SCRIPT = `try{var d=document.documentElement,t=localStorage.getItem("videogen-theme");if(t!=="light"&&t!=="dark"&&t!=="system")t="__VIDEOGEN_DESKTOP__" in window?"system":"light";d.dataset.theme=t;var w=parseInt(localStorage.getItem("videogen-side-width"),10);if(w>0)d.style.setProperty("--side-user-width",w+"px")}catch(e){if(!document.documentElement.dataset.theme)document.documentElement.dataset.theme="light"}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <Suspense><LocalizedDocument>{children}</LocalizedDocument></Suspense>;
}

async function LocalizedDocument({ children }: Pick<LayoutProps<"/">, "children">) {
  await io();
  return (
    <html
      lang={getLocale()}
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
      // Browser extensions (e.g. Google Analytics Opt-out) inject attributes on <html>.
      suppressHydrationWarning
    >
      <head>
        <InlineScript html={THEME_SCRIPT} />
      </head>
      {/* Each page brings its own chrome: the studio is full screen, the rest use <Shell>. */}
      <body className="flex min-h-full flex-col font-sans">
        <DesktopChrome />
        {children}
      </body>
    </html>
  );
}
