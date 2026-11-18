"use client";

import { t as translate } from "@/lib/i18n";
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__VIDEOGEN_DESKTOP__" in window;
}
export async function openProjectWindow(id: string) {
  if (!isDesktop()) { window.open(`/projects/${id}`, "_blank", "noopener"); return; }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_project", { id });
}

/** Native copy avoids buffering a large MP4 in the webview. */
export async function saveVideo(url: string, suggestedName = "VideoGen.mp4"): Promise<void> {
  if (!isDesktop()) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
    return;
  }
  const parsed = new URL(url, window.location.href);
  if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith("/api/files/")) throw new Error(translate("No video valid."));
  const relative = parsed.pathname.slice("/api/files/".length).split("/").map(decodeURIComponent).join("/");
  const [{ invoke }, { save }, { copyFile }] = await Promise.all([
    import("@tauri-apps/api/core"), import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs"),
  ]);
  const source = await invoke<string>("resolve_video", { relative });
  const destination = await save({ title: translate("Save MP4"), defaultPath: safeFileName(suggestedName), filters: [{ name: translate("MP4 video"), extensions: ["mp4"] }] });
  if (destination) await copyFile(source, destination);
}

/** A file name Windows accepts: no reserved characters, no trailing dot or space, at most 140 characters. */
function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 140).replace(/[. ]+$/, "") || "VideoGen.mp4";
}

/** Where an export lands unless the user picks another place: `folder` (the last one used) or the system's Videos folder. */
export async function defaultExportPath(folder: string, fileName: string): Promise<string> {
  const { join, videoDir } = await import("@tauri-apps/api/path");
  return join(folder || await videoDir(), safeFileName(fileName));
}

/**
 * The system's save dialog for an export, starting at `current`. `confirmed` is whether the dialog itself asked
 * about replacing that exact file (it did not when the name was typed without .mp4). Resolves to null if closed.
 */
export async function pickExportPath(current: string): Promise<{ path: string; confirmed: boolean } | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const chosen = await save({ title: translate("Choose where to save the video"), defaultPath: current, filters: [{ name: translate("MP4 video"), extensions: ["mp4"] }] });
  if (!chosen) return null;
  return /\.mp4$/i.test(chosen) ? { path: chosen, confirmed: true } : { path: `${chosen}.mp4`, confirmed: false };
}
