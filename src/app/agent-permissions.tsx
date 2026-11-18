"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { RadioGroup } from "radix-ui";
import { Select, SelectItem } from "@/components/ui/select";
import { AGENT_THRESHOLDS, type AgentMode } from "@/lib/app-settings-shared";
import "./agent-permissions.css";

export const AGENT_MODE_INFO: Record<AgentMode, { label: string; hint: string }> = localizedLabels((translate) => ({
  threshold: { label: translate("Automatic below the limit"), hint: translate("Edit instantly; generate voice or video on your own only if you do not exceed your time limit. If you exceed it, ask for confirmation.") },
  confirm: { label: translate("Confirm generation"), hint: translate("Editing starts immediately. Voice generation and video exports wait for your approval.") },
  auto: { label: translate("Run automatically"), hint: translate("All tools are run at the moment, without confirmation; with Claude Code or Codex, also your commands and file changes in the project folder.") },
}));

export function thresholdLabel(seconds: number) {
  return seconds < 60 ? `${seconds} s` : `${seconds / 60} min`;
}

/** Short text for the composer's pill. */
export function permissionSummary(mode: AgentMode, threshold: number) {
  return mode === "threshold" ? translate("Automatic up to {0}", thresholdLabel(threshold)) : mode === "confirm" ? translate("Confirm generation") : translate("Run automatically");
}

/** The three permission modes as a radio list; the limit lives inside the first one. */
export function AgentPermissionOptions({ mode, threshold, disabled, onMode, onThreshold }: {
  mode: AgentMode; threshold: number; disabled?: boolean;
  onMode: (mode: AgentMode) => void; onThreshold: (seconds: number) => void;
}) {
  return (
    <RadioGroup.Root className="agent-perm-list" value={mode} disabled={disabled} onValueChange={(v) => onMode(v as AgentMode)} aria-label={translate("Agent permissions")}>
      {(Object.keys(AGENT_MODE_INFO) as AgentMode[]).map((id) => (
        <div key={id} className="agent-perm-option" data-checked={mode === id || undefined}>
          <RadioGroup.Item value={id} id={`perm-${id}`} className="agent-perm-radio"><RadioGroup.Indicator className="agent-perm-dot" /></RadioGroup.Item>
          <label htmlFor={`perm-${id}`}>
            <strong>{AGENT_MODE_INFO[id].label}</strong>
            <span>{AGENT_MODE_INFO[id].hint}</span>
          </label>
          {id === "threshold" && mode === "threshold" && (
            <Select aria-label={translate("Automatic limit")} value={String(threshold)} disabled={disabled} className="agent-perm-limit" onValueChange={(v) => onThreshold(Number(v))}>
              {AGENT_THRESHOLDS.map((s) => <SelectItem key={s} value={String(s)} hint={s <= 60 ? translate("A short video") : translate("Longer videos")}>{translate("Videos from up to {0}", thresholdLabel(s))}</SelectItem>)}
            </Select>
          )}
        </div>
      ))}
    </RadioGroup.Root>
  );
}
