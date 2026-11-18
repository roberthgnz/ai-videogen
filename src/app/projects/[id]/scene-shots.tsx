"use client";

import { t as translate } from "@/lib/i18n";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { pickShotAction, searchShotAction } from "./actions";

export interface ShotCandidateView {
  key: string;
  kind: "video" | "image";
  thumbUrl: string;
  durationSec: number | null;
  pageUrl: string;
  author: string;
}

export interface ShotView {
  query: string;
  manual: boolean;
  selectedKey: string | null;
  candidates: ShotCandidateView[];
}

/**
 * The scene's b-roll: one thumbnail per shot. Opening a shot lists the
 * alternatives found for it and lets the user search for something else.
 */
export function SceneShots({
  projectId,
  sceneId,
  shots,
  credit,
  disabled,
}: {
  projectId: string;
  sceneId: string;
  shots: ShotView[];
  /** Provider credit shown next to its results. */
  credit: { label: string; url: string } | null;
  disabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (shots.length === 0) return null;
  const current = open !== null ? shots[open] : undefined;

  function toggle(index: number) {
    setError(null);
    setOpen(open === index ? null : index);
    setQuery(shots[index].query);
  }

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <p className="script-hint">{translate("Press an image to see others or look for something different.")}</p>
      <ul className="flex flex-wrap gap-2">
        {shots.map((shot, index) => {
          const selected = shot.candidates.find((c) => c.key === shot.selectedKey);
          return (
            <li key={index}>
              <button
                type="button"
                onClick={() => toggle(index)}
                aria-expanded={open === index}
                aria-label={translate("Image {0}: {1}", index + 1, shot.query)}
                title={shot.query}
                className={cn(
                  "relative block h-24 w-[54px] overflow-hidden rounded-lg border-2 bg-black/30 transition",
                  open === index ? "border-accent" : "border-transparent hover:border-foreground/30",
                )}
              >
                {selected ? (
                  // eslint-disable-next-line @next/next/no-img-element -- remote stock thumbnails, not app assets
                  <img src={selected.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center text-xs text-muted">—</span>
                )}
                <span className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 font-mono text-[10px] text-white">{index + 1}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {current && open !== null && (
        <div className="rise-in space-y-2 rounded-2xl border border-border bg-surface p-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => searchShotAction(projectId, sceneId, open, query));
            }}
          >
            <Input
              value={query}
              onValueChange={setQuery}
              maxLength={60}
              aria-label={translate("What to look for for {0}", open + 1)}
              placeholder="ocean waves aerial"
            />
            <Button type="submit" variant="outline" className="h-9" size="sm" disabled={disabled || pending || !query.trim()}>
              {pending ? "Buscando…" : translate("Search")}
            </Button>
          </form>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <ToggleGroup
            variant="cards"
            aria-label={translate("Alternative for the plane {0}", open + 1)}
            className="grid-cols-4"
            disabled={disabled || pending}
            value={current.selectedKey ?? ""}
            onValueChange={(key) => run(async () => pickShotAction(projectId, sceneId, open, key))}
          >
            {current.candidates.map((candidate) => (
              <ToggleGroupItem
                key={candidate.key}
                value={candidate.key}
                variant="cards"
                title={`${candidate.kind === "video" ? translate("Video") : "Foto"} de ${candidate.author}`}
                aria-label={`${candidate.kind === "video" ? translate("Video") : "Foto"} de ${candidate.author}`}
                className="relative aspect-[9/16] w-full overflow-hidden !border-2 !p-0"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- remote stock thumbnails, not app assets */}
                <img src={candidate.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
                  {candidate.kind === "video" ? `${Math.round(candidate.durationSec ?? 0)}s` : "foto"}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {credit && (
            <p className="text-xs text-muted">{translate("Results for")}{" "}
              <a href={credit.url} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                {credit.label}
              </a>
              {current.manual && translate(" · hand-chosen: automatic searches do not change")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
