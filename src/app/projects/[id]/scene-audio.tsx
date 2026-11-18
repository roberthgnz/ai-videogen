"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { Collapsible } from "radix-ui";
import { Button } from "@/components/ui/button";
import type { AudioStatus, WordTiming } from "@/lib/domain";

export interface SceneAudioInfo {
  status: AudioStatus;
  url: string | null;
  durationSec: number | null;
  words: WordTiming[];
  error: string | null;
}

/** How the voice of a scene stands, in the user's words, and the colour that goes with it (script-tools.css). */
export const VOICE_STATUS: Record<AudioStatus, { label: string; tone: "none" | "ok" | "warn" | "busy" | "bad" }> = localizedLabels((translate) => ({
  none: { label: translate("No voiceover"), tone: "none" },
  ready: { label: translate("Voice ready"), tone: "ok" },
  stale: { label: translate("Voice to be updated"), tone: "warn" },
  running: { label: translate("Generating the voice…"), tone: "busy" },
  error: { label: translate("The voice failed"), tone: "bad" },
}));

export function AudioBadge({ status }: { status: AudioStatus }) {
  const badge = VOICE_STATUS[status];
  return <span className="script-badge" data-tone={badge.tone}>{badge.label}</span>;
}

/** The voice of the open scene: how it stands, a player, a new take and the word timings. */
export function SceneAudio({
  info,
  unsaved,
  busy,
  onGenerate,
}: {
  info: SceneAudioInfo | undefined;
  /** Scene is new or its narration was edited and not saved yet. */
  unsaved: boolean;
  busy: boolean;
  onGenerate: (force: boolean) => void;
}) {
  if (!info) {
    return <p className="script-hint">{translate("Save the changes so you can generate the voice of this scene.")}</p>;
  }
  const canPlay = !!info.url && info.status !== "none";

  return (
    <div className="script-voice">
      <div>
        <AudioBadge status={info.status} />
        {info.durationSec != null && info.status !== "none" && <span>{translate("lasts")} {info.durationSec.toFixed(1).replace(".", ",")} s</span>}
        {info.status === "ready" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || unsaved}
            onClick={() => onGenerate(true)}
            title={translate("The same sentence, in other words (it spends voice credits)")}
          >{translate("Another shot")}</Button>
        ) : (
          <Button variant="outline" size="sm" disabled={busy || unsaved || info.status === "running"} onClick={() => onGenerate(false)}>
            {info.status === "error" ? translate("Retry") : info.status === "stale" ? translate("Update the voice") : translate("Generate the voice")}
          </Button>
        )}
      </div>

      {/* Why the button above does nothing right now. */}
      {unsaved && <p className="script-hint" data-tone="warn">{translate("You have changed the text: save the changes to be able to update the voice.")}</p>}
      {info.status === "stale" && !unsaved && <p className="script-hint">{translate("The text changed after recording it: this voice no longer says the same as the script.")}</p>}
      {info.status === "error" && info.error && <p className="script-hint" data-tone="bad">{info.error}</p>}

      {canPlay && <audio controls preload="none" src={info.url!} />}

      {info.words.length > 0 && info.status !== "none" && (
        <Collapsible.Root className="script-words">
          <Collapsible.Trigger>
            <span aria-hidden>›</span>{translate("When every word sounds (")}{info.words.length})
          </Collapsible.Trigger>
          <Collapsible.Content>
            {info.words.map((w) => (
              <span key={w.id} title={`${w.start}s → ${w.end}s`}>
                {w.text} <i>{w.start.toFixed(2)}</i>
              </span>
            ))}
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </div>
  );
}
