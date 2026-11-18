"use client";
import { t as translate } from "@/lib/i18n";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { saveVideo } from "@/lib/desktop";
import { STAGES } from "./video-panel";
import { startVideoAction, cancelVideoAction } from "./actions";
import type { EditorProject } from "./types";

export function ExportHistory({ project, disabled }: { project: EditorProject; disabled: boolean }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const videos = [...project.videos, ...Object.values(project.previews)];
  return <div className="unified-export-history">
    <p>{translate("Your previous versions and views, without leaving the studio.")}</p>
    {!videos.length && <div className="unified-script-empty"><h3>{translate("Your first version.")}</h3><p>{translate("Export the assembly or generate a video from Script. The versions will appear here.")}</p></div>}
    {videos.map((video, index) => <article key={video.id}>
      <header><strong>{video.sceneId ? translate("Preview of the scene") : translate("Version {0}", project.videos.length - index)}</strong><span>{video.format === "vertical" ? "9:16" : "16:9"}</span></header>
      {video.url && <video src={video.url} controls preload="metadata" playsInline />}
      <p>{video.status === "done" ? `${video.durationSec?.toFixed(2) ?? ""} s · MP4` : video.status === "error" ? translate("It couldn't be over") : video.status === "cancelled" ? translate("Cancelled") : `${STAGES[video.stage ?? ""] ?? translate("Preparing video")} · ${Math.round(video.progress)}%`}</p>
      {video.savedPath && <p className="break-all" title={video.savedPath}>{translate("Saved to")} {video.savedPath}</p>}
      {video.error && <p className="text-danger" role="alert">{video.error}</p>}
      {video.url && <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { await saveVideo(video.url!, `${project.title || "VideoGen"}-${index + 1}.mp4`); }
        catch { setError(translate("You couldn't save the video.")); }
        finally { setBusy(false); }
      }}>{translate("Download MP4")}</Button>}
      {["queued", "composing", "rendering"].includes(video.status) && <Button size="sm" variant="outline" onClick={() => void cancelVideoAction(video.id)}>{translate("Cancel")}</Button>}
      {(video.status === "error" || video.status === "cancelled") && <Button size="sm" variant="outline" disabled={disabled || busy} onClick={async () => {
        setBusy(true); setError("");
        try { const result = await startVideoAction(project.id, { sceneId: video.sceneId ?? undefined }); if (!result.ok) setError(result.error); }
        catch { setError(translate("The generation could not be restarted.")); }
        finally { setBusy(false); }
      }}>{translate("Re-generate")}</Button>}
    </article>)}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
