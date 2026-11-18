import { t as translate, localizedLabels, getLocale } from "@/lib/i18n";
import Link from "next/link";
import { io } from "next/cache";
import { Suspense } from "react";
import { videoView } from "@/lib/pipeline/steps/video";
import { latestVideo, listProjects, projectCover } from "@/lib/projects";
import { projectLibraryAssets } from "@/lib/global-assets";
import { AppNav } from "./app-nav";
import { NewProjectForm } from "./new-project-form";
import { ProjectCardMenu } from "./project-card-menu";
import "./home.css";

const FEATURES = localizedLabels((translate) => ([
  { label: translate("AI voices"), path: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3" },
  { label: translate("Music"), path: "M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" },
  { label: translate("Subtitles"), path: "M3 6h18v12H3V6Zm4 5h3m3 0h4M7 14h6m3 0h1" },
  { label: translate("Editing"), path: "M4 4h16v16H4V4Zm4 0v16m8-16v16M4 8h4m8 0h4M4 12h16M4 16h4m8 0h4" },
]));

export default function HomePage() {
  return (
    <div className="home">
      <AppNav current="projects" />
      <main className="home-main">
        <section className="home-hero">
          <h1>{translate("Create immersive videos")}</h1>
          <p>{translate("Use AI voices, music, and subtitles in one editor.")}</p>
          <ul className="home-features" aria-label={translate("Features")}>
            {FEATURES.map((f) => (
              <li key={f.label}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={f.path} /></svg>
                {f.label}
              </li>
            ))}
          </ul>
          <NewProjectForm />
        </section>
        <Suspense fallback={<p className="home-loading">{translate("Loading projects…")}</p>}>
          <ProjectGrid />
        </Suspense>
      </main>
    </div>
  );
}

const formatDate = (value: Date | number) => new Intl.DateTimeFormat(getLocale(), { day: "numeric", month: "short" }).format(value);

async function ProjectGrid() {
  await io();
  const projects = listProjects();
  if (projects.length === 0) return null;

  return (
    <section aria-labelledby="projects-title" className="home-projects">
      <div className="home-projects-head">
        <h2 id="projects-title">{translate("Your projects")}</h2>
        <span>{projects.length}</span>
      </div>
      <ul className="home-grid">
        {projects.map((p) => {
          const cover = projectCover(p.id);
          const name = p.title || p.topic || translate("Untitled");
          const latest = latestVideo(p.id);
          const downloadUrl = latest?.status === "done" && latest.outputPath ? `/api/files/${latest.outputPath}?v=${latest.updatedAt.getTime()}&download=1` : null;
          return (
            <li key={p.id} className="project-card">
              <Link href={`/projects/${p.id}`} className="project-card-link">
                <div className="project-card-cover">
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element -- remote stock thumbnail, not an app asset
                    <img src={cover} alt="" loading="lazy" />
                  ) : (
                    <span className="project-card-empty">{p.sceneCount > 0 ? translate("{0} scenes ready", p.sceneCount) : translate("Empty project")}</span>
                  )}
                  <span className="project-card-format">{p.format === "vertical" ? "9:16" : "16:9"}</span>
                  <VideoBadge projectId={p.id} />
                </div>
                <p className="project-card-title">{name}</p>
                <p className="project-card-meta">
                  {p.edit.clips.length || p.edit.overlays.length ? translate("{0} clips · {1} text overlays", p.edit.clips.length, p.edit.overlays.length) : translate("{0} scenes", p.sceneCount)} · {formatDate(p.updatedAt)}
                </p>
              </Link>
              <ProjectCardMenu id={p.id} name={name} downloadUrl={downloadUrl} libraryCount={projectLibraryAssets(p.id).length} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const BADGES = localizedLabels((translate) => ({
  queued: [translate("Generating"), "is-busy"],
  composing: [translate("Generating"), "is-busy"],
  rendering: [translate("Rendering"), "is-busy"],
  done: [translate("Video ready"), "is-done"],
  cancelled: [translate("Cancelled"), ""],
  error: ["Error", "is-error"],
} as const));

function VideoBadge({ projectId }: { projectId: string }) {
  const raw = latestVideo(projectId);
  if (!raw) return null;
  const [label, cls] = BADGES[videoView(raw).status];
  return <span className={`project-card-badge ${cls}`}>{label}</span>;
}
