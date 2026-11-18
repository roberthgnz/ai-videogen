"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { RadioGroup } from "radix-ui";
import { Input } from "@/components/ui/field";
import { AGENT_PROVIDER_INFO, AGENT_PROVIDERS, type AgentProviderId, type AgentProviderStatus, type CliProviderId } from "@/lib/app-settings-shared";
import "./agent-permissions.css";
import "./agent-providers.css";

const STATE_LABEL: Record<AgentProviderStatus["state"], string> = localizedLabels((translate) => ({
  ready: translate("Ready"),
  missing: "No instalado",
  "signed-out": translate("Signed out"),
  error: "No disponible",
}));

const MODEL_HINT: Record<CliProviderId, string> = localizedLabels((translate) => ({
  "claude-code": translate("Empty: that of your Claude Code"),
  codex: translate("Empty: that of your Codex. Ej.: gpt-5.1-codex"),
}));

/**
 * What runs the agent: the Anthropic API or one of the AI programs installed on this computer, each with
 * whether it is ready and, if not, what to do. An installed program can take a model name.
 */
export function AgentProviderOptions({ value, statuses, models, disabled, compact, onChange, onModel }: {
  value: AgentProviderId;
  statuses: AgentProviderStatus[];
  /** Without models the model field is hidden. */
  models?: Record<CliProviderId, string>;
  disabled?: boolean;
  /** For the chat's popover: no description and no model field. */
  compact?: boolean;
  onChange: (id: AgentProviderId) => void;
  onModel?: (id: CliProviderId, model: string) => void;
}) {
  const prefix = compact ? "chat-provider" : "provider";
  return (
    <RadioGroup.Root className="agent-perm-list" data-compact={compact || undefined} value={value} disabled={disabled} onValueChange={(v) => onChange(v as AgentProviderId)} aria-label={translate("Agent engine")}>
      {AGENT_PROVIDERS.map((id) => {
        const status = statuses.find((s) => s.id === id);
        return (
          <div key={id} className="agent-perm-option" data-checked={value === id || undefined}>
            <RadioGroup.Item value={id} id={`${prefix}-${id}`} aria-label={AGENT_PROVIDER_INFO[id].label} className="agent-perm-radio"><RadioGroup.Indicator className="agent-perm-dot" /></RadioGroup.Item>
            <label htmlFor={`${prefix}-${id}`}>
              <strong>{AGENT_PROVIDER_INFO[id].label}</strong>
              {!compact && <span>{AGENT_PROVIDER_INFO[id].hint}</span>}
            </label>
            <p className="agent-provider-status" data-state={status?.state ?? "checking"}>
              <i aria-hidden />
              <b>{status ? STATE_LABEL[status.state] : "Comprobando…"}</b>
              {status?.detail && <span>{status.detail}</span>}
            </p>
            {status?.problem && (!compact || value === id) && <p className="agent-provider-problem" role={value === id ? "alert" : undefined}>{status.problem}</p>}
            {id !== "anthropic" && value === id && models && onModel && (
              <label className="agent-provider-model">
                <span>{translate("Model (optional)")}</span>
                <Input value={models[id]} maxLength={80} placeholder={MODEL_HINT[id]} disabled={disabled} onValueChange={(value) => onModel(id, value)} />
              </label>
            )}
          </div>
        );
      })}
    </RadioGroup.Root>
  );
}
