import { t } from "@/lib/i18n";
import { io } from "next/cache";
import { Suspense } from "react";
import { listStyleProfiles, profileUsage } from "@/lib/style-profile/store";
import { AppNav } from "../app-nav";
import { StyleManager } from "./style-manager";
import "../home.css";
import "./style.css";

export async function generateMetadata() {
  await io();
  return { title: `${t("My style")} · VideoGen` };
}

export default function StylePage({ searchParams }: PageProps<"/style">) {
  return (
    <div className="home">
      <AppNav current="style" />
      <Suspense fallback={<p className="home-loading">{t("Loading your styles…")}</p>}>
        <StyleLoader searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function StyleLoader({ searchParams }: { searchParams: PageProps<"/style">["searchParams"] }) {
  const { perfil } = await searchParams;
  // Request-time only: the profiles live in a file the app writes.
  await io();
  return <StyleManager initialProfiles={listStyleProfiles()} usage={profileUsage()} initialId={typeof perfil === "string" ? perfil : null} />;
}
