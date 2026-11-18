"use client";

import { t as translate } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button, IconButton } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import type { AgentActionLog, AgentSuggestion } from "@/lib/domain";

export interface DockMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  actions: AgentActionLog[];
  suggestions: AgentSuggestion[];
  /** Set on the reply that last changed the montage: the user can undo it. `edited`: the montage changed again since. */
  undo?: { edited: boolean } | null;
}

/** The conversation with the agent, newest at the bottom (the "Historial" panel). */
export function HistoryPanel({
  messages,
  busy,
  live,
  onClear,
  canClear,
}: {
  messages: DockMessage[];
  busy: boolean;
  live: AgentActionLog[];
  onClear: () => void;
  canClear: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, busy, live.length]);

  if (messages.length === 0 && !busy) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted">
        <Sparkle size={22} />
        <p>{translate("Here you see what you ask the agent and what he does.")}</p>
        <p className="text-xs">{translate("Write it down: \"Make it shorter,\" \"change the clip from scene 2,\" \"generate the video.\"")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1" viewportRef={listRef}>
        <div role="log" aria-live="polite" className="flex flex-col gap-3 px-4 py-4">
          {messages.map((message) => (
            <Bubble key={message.id} message={message} />
          ))}
          {busy && (
            <div className="rise-in flex max-w-[95%] flex-col gap-1.5 self-start">
              <div className="glass inline-flex items-center gap-2 self-start rounded-2xl rounded-bl-md px-3.5 py-2.5 text-sm text-muted">
                <span className="flex gap-1" aria-hidden>
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </span>{translate("Working…")}</div>
              <ActionList actions={live} />
            </div>
          )}
        </div>
      </ScrollArea>
      {messages.length > 0 && (
        <div className="flex justify-end border-t border-white/[0.06] px-3 py-1.5">
          <Button size="sm" className="text-muted hover:text-foreground" onClick={() => setConfirming(true)} disabled={!canClear}>{translate("Delete conversation")}</Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={translate("Delete the conversation?")}
        description={translate("The history is deleted with the agent of this project. The script and the videos do not change.")}
        confirmLabel="Borrar"
        onConfirm={() => {
          setConfirming(false);
          onClear();
        }}
      />
    </div>
  );
}

function Bubble({ message }: { message: DockMessage }) {
  if (message.role === "user") {
    return (
      <div className="rise-in max-w-[88%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-white/[0.14] px-3.5 py-2 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
        {message.text}
      </div>
    );
  }
  return (
    <div className="rise-in flex max-w-[95%] flex-col gap-1.5 self-start">
      <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
      <ActionList actions={message.actions} />
    </div>
  );
}

/** What the agent did, one small pill per action (hover for the detail). */
function ActionList({ actions }: { actions: AgentActionLog[] }) {
  if (actions.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {actions.map((action, i) => (
        <li
          key={`${action.tool}-${i}`}
          title={action.detail}
          className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
            action.ok ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200" : "border-danger/40 bg-danger/10 text-danger"
          }`}
        >
          <span aria-hidden>{action.ok ? "✓" : "✗"}</span>
          <span className="truncate">{action.label}</span>
          {!action.ok && action.detail && <span className="truncate text-danger/80">· {action.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The prompt bar at the bottom of the studio. A selected scene shows as a chip:
 * the message is then about that scene. The proposed next steps sit above it.
 */
export function PromptBar({
  value,
  onChange,
  onSend,
  busy,
  sending,
  placeholder,
  context,
  onClearContext,
  suggestions,
  onSuggestion,
  lastReply,
  onOpenHistory,
  error,
  onPlus,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  sending: boolean;
  placeholder: string;
  /** e.g. "Escena 3" when a scene is selected. */
  context: string | null;
  onClearContext: () => void;
  suggestions: AgentSuggestion[];
  onSuggestion: (s: AgentSuggestion) => void;
  /** The agent's last answer, shown above the bar while the history panel is closed. */
  lastReply: string | null;
  onOpenHistory: () => void;
  error: string | null;
  onPlus: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const working = busy || sending;

  // Grow the box with what is typed (up to five lines).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [value]);

  return (
    <div className="flex w-full max-w-[680px] flex-col gap-2">
      {lastReply && (
        <Tooltip content="Abrir el historial" side="top">
          <button
            type="button"
            onClick={onOpenHistory}
            className="rise-in line-clamp-1 self-start px-2 text-left text-sm text-foreground/85 hover:text-foreground"
          >
            <Sparkle size={12} /> {lastReply}
          </button>
        </Tooltip>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-danger/15 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {suggestions.length > 0 && !busy && (
        <ul className="flex flex-wrap gap-2" aria-label={translate("Next steps")}>
          {suggestions.map((suggestion) => (
            <li key={`${suggestion.label}-${suggestion.tool ?? suggestion.href}`}>
              <Button variant="chip" size="none" disabled={working && !suggestion.href} onClick={() => onSuggestion(suggestion)}>
                <Sparkle size={12} />
                {suggestion.label}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="prompt-bar flex flex-col gap-1 rounded-[26px] p-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <Label htmlFor="agent-input" className="sr-only">{translate("Tell the assistant what you want")}</Label>
        <textarea
          id="agent-input"
          ref={inputRef}
          value={value}
          rows={1}
          maxLength={4000}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={busy ? "Trabajando en ello…" : placeholder}
          className="max-h-[132px] min-h-[40px] w-full resize-none bg-transparent px-3 pt-2 text-[15px] leading-6 outline-none placeholder:text-muted/80 focus-visible:shadow-none"
        />
        <div className="flex items-center gap-2">
          <IconButton label={translate("Add Scene")} variant="glass" tooltipSide="top" onClick={onPlus}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </IconButton>
          <span className="flex-1" />
          {context && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.09] py-1 pl-3 pr-1 text-xs font-medium">
              {context}
              <IconButton label={`Quitar ${context}`} size="icon-sm" className="!h-6 !w-6 text-[11px]" tooltipSide="top" onClick={onClearContext}>
                ✕
              </IconButton>
            </span>
          )}
          <Button type="submit" variant="primary" size="icon" aria-label={translate("Send")} disabled={working || !value.trim()} className="hover:scale-105">
            {working ? <span className="typing-dot" /> : <ArrowRight />}
          </Button>
        </div>
      </form>
      <p className="hidden px-3 text-center text-[11px] text-muted/80 [@media(min-height:820px)]:block">{translate("The agent may be wrong: check the result before publishing it.")}</p>
    </div>
  );
}

function ArrowRight() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function Sparkle({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className="inline text-accent">
      <path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2zm7 12l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14z" />
    </svg>
  );
}
