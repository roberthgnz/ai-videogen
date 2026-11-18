import { t } from "@/lib/i18n";
import { io } from "next/cache";
import { Suspense } from "react";
import { listGlobalAssets, syncExistingAssetsToGlobal } from "@/lib/global-assets";
import { AppNav } from "../app-nav";
import { LibraryView } from "./library-view";
import "../home.css";

export async function generateMetadata() {
  await io();
  return { title: `${t("Library")} · VideoGen` };
}

export default function GlobalLibraryPage() {
  return (
    <div className="home">
      <AppNav current="library" />
      <main className="home-main">
        <Suspense fallback={<p className="home-loading library-loading">{t("Loading library…")}</p>}>
          <LibraryLoader />
        </Suspense>
      </main>
    </div>
  );
}

async function LibraryLoader() {
  // Request-time only: with cacheComponents the list would otherwise be frozen at build time.
  await io();
  // Pick up what projects made since the last visit (renders, voices, stock, uploads).
  syncExistingAssetsToGlobal();
  return <LibraryView initialAssets={listGlobalAssets()} />;
}
