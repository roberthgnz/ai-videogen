"use client";

import { t as translate } from "@/lib/i18n";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startVideoAction } from "../actions";
import type { EditorProject } from "../types";
import { VideoPanel } from "../video-panel";
import type { PipelineStepView, StepState } from "./steps";

const ICON: Record<StepState, [string, string]> = {
  done: ["✓", "border-emerald-500/60 text-emerald-400"],
  running: ["…", "border-accent text-accent"],
  error: ["!", "border-danger text-danger"],
  pending: ["·", "border-border text-muted"],
};

export function ResultView({ project, steps }: { project: EditorProject; steps: PipelineStepView[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const anyRunning = steps.some((s) => s.state === "running");

  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => router.refresh(), 1000);
    return () => clearInterval(timer);
  }, [anyRunning, router]);

  function retry() {
    setError(null);
    startTransition(async () => {
      const result = await startVideoAction(project.id, {});
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="space-y-6">
      <section className="glass rounded-3xl p-5">
        <h2 className="mb-3 text-lg font-semibold">{translate("Status")}</h2>
        <ol className="space-y-3">
          {steps.map((step) => {
            const [icon, cls] = ICON[step.state];
            return (
              <li key={step.key} className="flex gap-3">
                <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border text-sm ${cls}`}>
                  {icon}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{step.label}</span>
                    <span className="text-sm text-muted">{step.detail}</span>
                  </div>
                  {step.state === "error" && step.error && (
                    <div className="space-y-2">
                      <pre className="whitespace-pre-wrap rounded-xl bg-danger/10 p-2 font-mono text-xs text-danger">
                        {step.error}
                      </pre>
                      {step.key === "script" ? (
                        <Link href={`/projects/${project.id}`} className="text-sm text-accent hover:underline">{translate("Back to the editor to retry the script")}</Link>
                      ) : (
                        <Button variant="outline" size="sm" onClick={retry} disabled={pending || anyRunning}>{translate("Retry from this step")}</Button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {error && (
          <pre role="alert" className="mt-3 whitespace-pre-wrap rounded-xl bg-danger/10 p-2 font-mono text-xs text-danger">
            {error}
          </pre>
        )}
      </section>

      <VideoPanel
        projectId={project.id}
        format={project.format}
        videos={project.videos}
        blocked={!project.voiceId ? translate("Choose a voice from the editor.") : project.scenes.length === 0 ? translate("Generate the script first.") : null}
      />
    </div>
  );
}
