"use client";

import { t as translate } from "@/lib/i18n";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Popover } from "radix-ui";
import { ANTHROPIC_MODELS, CLAUDE_CODE_MODELS, effortHint, effortLabel, findModel, type AgentChoice, type EngineCatalog, type EngineModel } from "@/lib/agent-models";
import { AGENT_PROVIDER_INFO, AGENT_PROVIDERS, type AgentProviderId, type AgentProviderStatus } from "@/lib/app-settings-shared";
import { agentChoiceAction, codexModelsAction, setAgentChoiceAction } from "./settings-actions";
import "./agent-model-picker.css";

/** What the picker starts from; the studio passes it from the page, the home screen reads it once mounted. */
export interface AgentPickerState {
  choice: AgentChoice;
  statuses: AgentProviderStatus[];
  /** The model the API runs with its setting empty (ANTHROPIC_MODEL). */
  apiModel: string;
}

const ENGINE_SHORT: Record<AgentProviderId, string> = { anthropic: "API", "claude-code": "Claude Code", codex: "Codex" };

function staticCatalog(provider: AgentProviderId, apiModel: string): EngineCatalog | null {
  if (provider === "anthropic") return { models: ANTHROPIC_MODELS, defaultModel: apiModel };
  if (provider === "claude-code") return { models: CLAUDE_CODE_MODELS, defaultModel: "" };
  return null;
}

/** «Claude Opus 5.5 · Medio», «Claude Code · Opus», «Codex · GPT-6.1-Sol · Alto»: what the next message runs with. */
function choiceLabel(choice: AgentChoice, model: EngineModel | undefined): string {
  const name = model?.label ?? (choice.model || "Por defecto");
  const engine = choice.provider === "anthropic" ? name : `${ENGINE_SHORT[choice.provider]} · ${name}`;
  return choice.effort ? `${engine} · ${effortLabel(choice.effort)}` : engine;
}

/**
 * The model and how hard it thinks, chosen in the message box as in a coding app: engines on the left, their
 * models in the middle, reasoning levels on the right. A click saves it (Ajustes keeps the same values) and the
 * next message runs with it.
 */
export function AgentModelPicker({ initial, busy, side = "top", align = "end" }: {
  initial?: AgentPickerState;
  /** The agent is working: the change applies from the next message. */
  busy?: boolean;
  side?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const [loaded, setLoaded] = useState<AgentPickerState | null>(null);
  const [saved, setSaved] = useState<AgentChoice | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AgentProviderId>("anthropic");
  const [codex, setCodex] = useState<EngineCatalog | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const state = initial ?? loaded;
  const choice = saved ?? state?.choice ?? null;

  // The home screen has no settings in its props: read them once.
  useEffect(() => {
    if (initial) return;
    let live = true;
    agentChoiceAction().then((s) => { if (live) setLoaded(s); }, () => { /* the button stays as «Modelo» */ });
    return () => { live = false; };
  }, [initial]);
  // Codex's list comes from the program: read it when it is the engine in use or the one being looked at.
  const needCodex = choice?.provider === "codex" || (open && view === "codex");
  useEffect(() => {
    if (!needCodex || codex) return;
    let live = true;
    codexModelsAction().then((c) => { if (live) setCodex(c); }, () => { if (live) setCodex({ models: [], problem: "No he podido leer los modelos de Codex." }); });
    return () => { live = false; };
  }, [needCodex, codex]);

  const catalogOf = (provider: AgentProviderId) => staticCatalog(provider, state?.apiModel ?? "") ?? codex;
  const current = choice ? catalogOf(choice.provider) : null;
  const currentModel = choice && current ? findModel(current, choice.model) : undefined;
  const label = choice ? choiceLabel(choice, currentModel) : translate("Model");

  function save(next: AgentChoice) {
    setError(null);
    const before = saved;
    setSaved(next);
    start(async () => {
      const result = await setAgentChoiceAction(next).catch(() => ({ ok: false as const, error: translate("It couldn't be saved. Recharge the page and try again.") }));
      if (!result.ok) { setSaved(before); setError(result.error); }
    });
  }
  function pickModel(model: EngineModel) {
    if (!choice) return;
    // The effort carries over when the new model takes it; otherwise the model decides.
    const effort = choice.provider === view && model.efforts.includes(choice.effort) ? choice.effort : "";
    save({ provider: view, model: model.id, effort });
  }

  const viewCatalog = catalogOf(view);
  const status = state?.statuses.find((s) => s.id === view);
  const active = choice?.provider === view;
  const selectedModel = active && viewCatalog && choice ? findModel(viewCatalog, choice.model) : undefined;

  return <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) { setView(choice?.provider ?? "anthropic"); setError(null); } }}>
    <Popover.Trigger asChild>
      <button type="button" className="model-picker-trigger" disabled={!choice} title={translate("Model of the agent: {0}", label)} aria-label={translate("Model of the agent: {0}", label)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" /></svg>
        <span>{label}</span>
        <svg className="model-picker-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content side={side} align={align} sideOffset={8} collisionPadding={12} className="ui-pop model-picker">
      <nav className="model-picker-engines" aria-label={translate("Engine")}>
        {AGENT_PROVIDERS.map((id) => {
          const s = state?.statuses.find((x) => x.id === id);
          return <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>
            <i data-state={s?.state ?? "checking"} aria-hidden />
            <span>{AGENT_PROVIDER_INFO[id].label}</span>
            {choice?.provider === id && <small>{translate("In use")}</small>}
          </button>;
        })}
      </nav>
      <section className="model-picker-models" aria-label={`Modelos de ${AGENT_PROVIDER_INFO[view].label}`}>
        <h3>{translate("Model")}</h3>
        {status && status.state !== "ready" && status.problem && <p className="model-picker-problem">{status.problem}</p>}
        {!viewCatalog ? <p className="model-picker-note" role="status"><i className="model-picker-spinner" aria-hidden />{translate("Loading Codex models…")}</p>
          : viewCatalog.problem ? <p className="model-picker-problem">{viewCatalog.problem}</p>
          : <div role="radiogroup" aria-label={translate("Model")}>
            {viewCatalog.models.map((m) => {
              const checked = active && selectedModel?.id === m.id;
              return <button type="button" role="radio" aria-checked={checked} key={m.id || "default"} disabled={pending} onClick={() => pickModel(m)}>
                <span><strong>{m.label}</strong>{m.hint && <small>{m.hint}</small>}</span>
                {checked && <Check />}
              </button>;
            })}
          </div>}
      </section>
      <section className="model-picker-efforts" aria-label={translate("Reasoning")}>
        <h3>{translate("Reasoning")}</h3>
        {!active || !choice ? <p className="model-picker-note">{translate("Choose a model of")} {AGENT_PROVIDER_INFO[view].label}{translate("to adjust how much you think.")}</p>
          : !selectedModel?.efforts.length ? <p className="model-picker-note">{translate("This model only decides how much it thinks.")}</p>
          : <div role="radiogroup" aria-label={translate("Reasoning")}>
            {["", ...selectedModel.efforts].map((e) => {
              const checked = choice.effort === e;
              const hint = e ? effortHint(e) : selectedModel.defaultEffort ? `Lo decide el modelo (${effortLabel(selectedModel.defaultEffort).toLowerCase()})` : "Lo decide el modelo";
              return <button type="button" role="radio" aria-checked={checked} key={e || "auto"} disabled={pending} onClick={() => save({ ...choice, effort: e })}>
                <span><strong>{e ? effortLabel(e) : translate("Automatic")}</strong>{hint && <small>{hint}</small>}</span>
                {checked && <Check />}
              </button>;
            })}
          </div>}
      </section>
      <footer>
        {error ? <p className="model-picker-problem" role="alert">{error}</p>
          : <p>{busy ? translate("The agent is working: the change is applied from the next message.") : translate("It applies from the next message.")}</p>}
        <Link href="/settings#agente">{translate("Settings")}</Link>
      </footer>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

function Check() {
  return <svg className="model-picker-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}
