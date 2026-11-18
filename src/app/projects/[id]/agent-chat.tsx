"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { useEffect, useRef, useState, useTransition, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Popover } from "radix-ui";
import type { AgentActionLog, AgentSuggestion } from "@/lib/domain";
import type { AgentMode } from "@/lib/app-settings-shared";
import { AGENT_PROVIDER_INFO } from "@/lib/app-settings-shared";
import { AgentPermissionOptions, permissionSummary } from "../../agent-permissions";
import { AgentModelPicker } from "../../agent-model-picker";
import { checkAgentProvidersAction, setAgentEngineAction, setAgentPermissionsAction } from "../../settings-actions";
import { EditorIcon, type EditorIconName } from "./desktop-controls";
import { answerApprovalAction, cancelAgentTurnAction, runSuggestionAction, sendAgentMessageAction } from "./agent-actions";
import { cancelVideoAction, saveGenerationSettingsAction } from "./actions";
import { onScreenText } from "./editor-state";
import { narrationSeconds as sceneNarrationSeconds, sceneSpans, totalOf } from "./timeline-math";
import type { AgentView } from "./studio";
import type { EditorProject } from "./types";
import { STAGES } from "./video-panel";
import { VoicePicker } from "./voice-picker";
import { StyleRuleProposals } from "./style-rule-proposals";
import "./agent-chat.css";

interface Props {
  project: EditorProject;
  agent: AgentView;
  disabled: boolean;
  selected: string | null;
  prompt: string;
  onPrompt: (value: string) => void;
  onSend: () => void;
  onUndo: (messageId: string, edited: boolean) => void;
  /** Opens the script tools, on its scenes or on «Voz y estilo». */
  onOpenScript: (tab: "scenes" | "settings") => void;
  onImport: () => void;
  /** Shows the exported versions in the library column. */
  onOpenExports: () => void;
  /** Opens the export dialog, as the toolbar's «Exportar» does: quality and where to save the MP4. */
  onExport: () => void;
  /** The montage already has clips: the guide's timeline step is done and what is left is exporting. */
  hasMontage: boolean;
  /**
   * The project's next step (the passes: review, go on, export), shown right above the message box. While it is
   * there it holds the one filled button: the chat's own proposals and ideas step back.
   */
  nextStep?: React.ReactNode;
}

/**
 * A server action that threw instead of answering: say plainly when the studio cannot be reached (closed,
 * restarting) so the user reloads, and otherwise what failed — never a bare «No se pudo ejecutar».
 */
function failed(what: string) {
  return (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    const offline = error instanceof TypeError || /failed to fetch|network|connection|ECONNREFUSED|load failed/i.test(text);
    const detail = text && text.length < 160 && !/Server Components|digest/i.test(text) ? `: ${text}` : translate("Recharge the page and try again.");
    return {
      ok: false as const,
      error: offline
        ? translate("The connection to the study has been lost (it may have been closed or reinitiated). Recharge the page and try again.")
        : `${what.replace(/\.$/, "")}${detail}`,
    };
  };
}

/** Older messages carried the studio's context for the model ("[Guion y generación] [Sobre el elemento …]"); the chat shows only the words. */
function withoutContextTags(text: string) {
  return text.replace(/^(\[(Montaje editable|Guion y generación|Sobre el elemento [^\]\n]{1,80})\]\s*)+/, "");
}

/**
 * Ways to start, for someone who has never prompted an editor: each puts a request in the message box that
 * already says what a good one says (what, how long, with what), to finish or change before sending.
 */
const STARTERS: { icon: EditorIconName; title: string; hint: string; prompt: string; needsFiles?: boolean }[] = localizedLabels((translate) => ([
  { icon: "sparkles", title: translate("Create a video from an idea"), hint: translate("Say the subject: the agent writes the script, puts the voice and rides it."), prompt: translate("Make a 30-second video about ") },
  { icon: "media", title: translate("Edit a video with my files"), hint: translate("With your clips, photos and music."), prompt: translate("Set up a 30-second video with the files in my library."), needsFiles: true },
  { icon: "chat", title: translate("I don't know where to start"), hint: translate("The agent asks you what you need and you plan it together."), prompt: translate("I don't know where to start, ask me any questions you need to plan the video.") },
]));

/**
 * Requests worth making at each point of the project. The chip names the result in two or three words; a tap
 * puts the whole request in the message box, written the way the agent understands best, to send or to change.
 */
function ideasFor(p: Props): { label: string; prompt: string }[] {
  if (p.selected) return [
    { label: "Acortarlo", prompt: translate("Take it in half.") },
    { label: "Quitarlo", prompt: translate("Get him off the set.") },
    { label: "Pedir consejo", prompt: translate("What would you do with this to make it better?") },
  ];
  // The next step already says what to do and how to ask for changes: more chips would only compete with it.
  if (p.nextStep) return [];
  if (p.hasMontage) return [
    { label: translate("Add a title"), prompt: translate("Add a title to the beginning that reads ") },
    { label: translate("Cut to the beat"), prompt: translate("Adjust the cuts to the rhythm of music.") },
    { label: translate("Review the edit"), prompt: translate("Check the assembly and tell me what you'd get better.") },
  ];
  if (p.project.scenes.length) return [
    { label: translate("Cut the script"), prompt: translate("Make the script shorter, about 20 seconds.") },
    { label: translate("Change the tone"), prompt: translate("Rewrite the script with a closer tone.") },
    { label: translate("Add a closure"), prompt: translate("Add a final scene that invites you to continue to see more.") },
  ];
  return [];
}

/** The render's stages in plain words: what is happening to the video, not how it is built. */
const PLAIN_STAGES: Record<string, string> = localizedLabels((translate) => ({
  tts: translate("Recording the voice"),
  visuals: translate("Looking for images for each scene"),
  compose: translate("Riding the scenes"),
  compile: translate("Riding the scenes"),
  extract_video: translate("Preparing your files"),
  process_audio: "Ajustando el sonido",
  start_browsers: translate("Preparing the video"),
  capture: translate("Creating the video images"),
  encode: translate("Creating the video"),
  assemble: translate("Ending the video"),
}));

/**
 * The agent's conversation, built so there is one place to look for what comes next. From top to bottom:
 * what was said (each reply with what it did folded into one line), then the next step — the guide from
 * script to voice to timeline, or the passes' card — and the message box. Only one button is filled at a time.
 */
export function AgentChat(p: Props) {
  const router = useRouter();
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // The conversation follows what arrives only while the user is at its end: once they scroll up to read, it stays put.
  const pinned = useRef(true);
  const seen = useRef(0);
  const [away, setAway] = useState(false);
  const [running, start] = useTransition();
  /** The button that was pressed: it shows the wait, the others only step back. */
  const [runningLabel, setRunningLabel] = useState<string | null>(null);
  const [clickError, setClickError] = useState<string | null>(null);
  const messages = p.agent.messages;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const scriptMessage = [...messages].reverse().find((m) => m.actions?.some((a) => a.ok && a.tool === "write_script"));
  const blocked = p.disabled || running;
  const hasFiles = p.project.edit.assets.length > 0;
  // The last turn failed (engine not ready, a usage limit, a bad model…): its request, to send again in one click.
  const failedRequest = lastAssistant && lastAssistant === messages.at(-1) && /^No he podido completarlo/.test(lastAssistant.text)
    ? messages.at(-2)?.role === "user" ? withoutContextTags(messages.at(-2)!.text) : null
    : null;
  function retry() {
    if (!failedRequest) return;
    setClickError(null);
    start(async () => {
      const result = await sendAgentMessageAction(p.project.id, failedRequest, p.hasMontage ? translate("Editable timeline") : translate("Script and generation"))
        .catch(failed(translate("It couldn't be sent.")));
      if (!result.ok) setClickError(result.error);
    });
  }

  // Follow the conversation: new messages, the agent's live steps and the guide land in view. Never against
  // the user: what they send always comes into view, the rest only if they have not scrolled away to read.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const sent = messages.length > seen.current && messages.at(-1)?.role === "user";
    seen.current = messages.length;
    if (sent) pinned.current = true;
    if (pinned.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages, p.agent.busy, p.agent.live.length, p.project.scenes.length, p.agent.approvals.length, p.agent.liveText, clickError]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    pinned.current = atEnd;
    setAway(!atEnd);
  }
  function toEnd() {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  function run(s: AgentSuggestion) {
    if (s.href) { if (/\/(?:results|resultado)(?:[?#]|$)|panel=exports/.test(s.href)) p.onOpenExports(); else router.push(s.href); return; }
    // Exporting the montage goes through the export dialog, as from the toolbar, so the user picks quality and folder.
    // An approval the agent is waiting for, or a proposal with its own options, still runs as proposed.
    if (s.tool === "generate_video" && p.hasMontage && !s.label.startsWith("Aprobar:") && !Object.keys(s.input ?? {}).length) { p.onExport(); return; }
    setClickError(null);
    setRunningLabel(s.label);
    start(async () => {
      const result = await runSuggestionAction(p.project.id, s).catch(failed(translate("It couldn't be executed.")));
      if (!result.ok) setClickError(result.error);
      setRunningLabel(null);
    });
  }
  // One filled button, not two: the approval the agent is waiting for; else its first proposal, unless the
  // project's next step is on screen with its own.
  const approval = p.agent.suggestions.findIndex((s) => s.label.startsWith("Aprobar:"));
  const primary = approval >= 0 ? approval : p.nextStep ? -1 : 0;

  return <div className="pro-assistant">
    <div ref={scroller} className="pro-assistant-messages" onScroll={onScroll}>
      {/* A montage made by hand and nothing said yet: the next step below already says where to go, so the chat only says what it is for. */}
      {!messages.length && !p.agent.busy && !p.project.scenes.length && !!p.nextStep && <div className="pro-assistant-intro">
        <div className="pro-ai-orb"><EditorIcon name="sparkles" /></div>
        <h3>{translate("Ask the agent for changes")}</h3>
        <p>{translate("Write it down with your words, like an editor: \"shorten the principle,\" \"put a title,\" \"remove the silences.\"")}</p>
      </div>}
      {!messages.length && !p.agent.busy && !p.project.scenes.length && !p.nextStep && <div className="pro-assistant-intro">
        <div className="pro-ai-orb"><EditorIcon name="sparkles" /></div>
        <h3>{translate("What video do you want to do?")}</h3>
        <p>{translate("Ask the agent with your words, like an editor. He does the job; you check and ask for changes.")}</p>
        {/* A starter lands in the message box, ready to finish or change; the one about files asks for them first if there are none. */}
        <ul className="chat-starters">
          {STARTERS.map((s) => <li key={s.title}><button type="button" disabled={p.disabled} onClick={() => { p.onPrompt(s.prompt); input.current?.focus(); if (s.needsFiles && !hasFiles) p.onImport(); }}>
            <span><EditorIcon name={s.icon} /></span>
            <span><strong>{s.title}</strong><small>{s.needsFiles && !hasFiles ? translate("First choose your clips, photos or music.") : s.hint}</small></span>
          </button></li>)}
        </ul>
        <small>{translate("The more concrete, the better: theme, duration, tone and to whom it is addressed.")}</small>
      </div>}

      {messages.map((m) => {
        const canRetry = m === lastAssistant && m === messages.at(-1) && !!failedRequest && !p.agent.busy;
        const canUndo = !!m.undo && !p.agent.busy;
        return <article key={m.id} className={`pro-message pro-message-${m.role}`}>
          <span>{m.role === "user" ? translate("You") : "VideoGen"}</span>
          <p>{m.role === "user" ? withoutContextTags(m.text) : m.text}</p>
          {m === scriptMessage && p.project.scenes.length > 0 && <ScriptCard project={p.project} onOpen={() => p.onOpenScript("scenes")} />}
          {/* What it did, folded, and the way back, on one line: the reply above is what there is to read. */}
          {m.role === "assistant" && (!!m.actions?.length || canUndo || canRetry) && <div className="chat-turn-row">
            {!!m.actions?.length && <ActionList actions={m.actions} />}
            {(canUndo || canRetry) && <div className="chat-turn-actions">
              {canRetry && <button type="button" data-primary disabled={blocked} onClick={retry}>{running && !runningLabel ? <span className="pro-spinner" /> : <EditorIcon name="redo" />}{translate("Retry")}</button>}
              {canUndo && <button type="button" title={translate("Leave the assembly as it was before this answer")} onClick={() => p.onUndo(m.id, m.undo!.edited)}><EditorIcon name="undo" />{translate("Undo")}</button>}
            </div>}
          </div>}
          {m === lastAssistant && !p.agent.busy && p.agent.suggestions.length > 0 && <div className="chat-suggestions" role="group" aria-label={translate("Next steps")}>
            {p.agent.suggestions.map((s, i) => {
              const waiting = running && runningLabel === s.label;
              return <button type="button" key={`${s.label}-${i}`} data-primary={i === primary || undefined} data-waiting={waiting || undefined} disabled={blocked} onClick={() => run(s)}>
                {waiting ? <span className="pro-spinner" /> : s.tool ? <EditorIcon name="sparkles" /> : null}
                <span>{s.label.replace(/^Aprobar:\s*/, "Aprobar · ")}</span>
                {!s.tool && <i aria-hidden>↗</i>}
              </button>;
            })}
          </div>}
        </article>;
      })}

      {!p.agent.busy && <StyleRuleProposals projectId={p.project.id} refreshKey={messages.length} disabled={p.disabled} />}
      {p.agent.busy && <>
        {p.agent.liveText && <article className="pro-message pro-message-assistant chat-live-text" aria-live="polite"><span>VideoGen</span><p>{p.agent.liveText.slice(-1600)}</p></article>}
        {p.agent.approvals.map((a) => <ApprovalCard key={a.id} projectId={p.project.id} approval={a} engine={p.agent.provider.label} />)}
        <WorkingCard agent={p.agent} />
      </>}

      {p.project.scenes.length > 0 && !p.agent.busy && !p.hasMontage && <VideoGuide {...p} blocked={blocked} onRun={run} runningLabel={running ? runningLabel : null} />}
      {clickError && <div className="chat-notice" role="alert"><p>{clickError}</p><button type="button" aria-label={translate("Close Warning")} onClick={() => setClickError(null)}><EditorIcon name="close" /></button></div>}
      {away && <div className="chat-jump"><button type="button" aria-label={translate("Go to the end of the conversation")} onClick={toEnd}><EditorIcon name="send" /></button></div>}
    </div>
    {p.nextStep}
    <Composer {...p} inputRef={input} onError={setClickError} />
  </div>;
}

/**
 * The agent's turn in progress: who is working, the step it is on (the one thing to read), and the last few
 * it finished. The step gets the card's full width: the way to stop it is the composer's send button, which
 * turns into «Detener» for as long as this card is up.
 */
function WorkingCard({ agent }: { agent: AgentView }) {
  // Engines hand over steps that end in their own dots or a colon: one ellipsis, ours.
  const step = (agent.step ?? translate("Preparing your changes")).replace(/[\s.…:,;]+$/, "");
  const recent = agent.live.slice(-4);
  return <div className="chat-working" role="status" aria-live="polite">
    <header><span className="pro-spinner" /><span>{agent.provider.label}{translate("is working")}</span></header>
    <strong title={step}>{step}…</strong>
    {recent.length > 0 && <ul>{recent.map((a, i) => <li key={i} data-ok={a.ok || undefined} title={a.ok ? a.label : a.detail ?? a.label}><EditorIcon name={a.ok ? "check" : "close"} /><span>{a.label}</span></li>)}</ul>}
    <em>{translate("You can continue to see the assembly. To stop it, click \"Stop\" below.")}</em>
  </div>;
}

/**
 * The chosen engine cannot run: what is missing, and the ways out right here — check again (after signing in
 * in a terminal) or switch to an engine that is ready.
 */
function EngineProblem({ agent }: { agent: AgentView }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const ready = agent.provider.statuses.filter((s) => s.state === "ready" && s.id !== agent.provider.id);
  return <div className="chat-engine-problem" role="alert">
    <p><strong>{translate("The agent (")}{agent.provider.label}{translate(") is unavailable right now.")}</strong> {agent.provider.problem}</p>
    <div>
      <button type="button" disabled={pending} onClick={() => start(async () => {
        setNote(null);
        const statuses = await checkAgentProvidersAction().catch(() => null);
        const mine = statuses?.find((s) => s.id === agent.provider.id);
        setNote(!statuses ? translate("It couldn't be checked.") : mine?.state === "ready" ? null : translate("He's still not ready."));
      })}>{pending ? "Comprobando…" : translate("Check again")}</button>
      {ready.map((s) => <button type="button" key={s.id} disabled={pending} onClick={() => start(async () => {
        const result = await setAgentEngineAction(s.id).catch(failed(translate("You couldn't change the engine.")));
        setNote(result.ok ? null : result.error);
      })}>{translate("Use")} {AGENT_PROVIDER_INFO[s.id].label}</button>)}
      <Link href="/settings#agente">{translate("Settings")}</Link>
    </div>
    {note && <small>{note}</small>}
  </div>;
}

/** Claude Code's and Codex's own steps (terminal, files, web) as opposed to the studio's tools. */
const isOwnStep = (tool: string) => /^[A-Z]/.test(tool) || tool === "terminal" || tool === "archivos" || tool === "web";

/** The same step several times in one turn («Revisar el montaje» twice) reads once, with its count. */
function grouped(actions: AgentActionLog[]) {
  const out: { action: AgentActionLog; times: number }[] = [];
  for (const action of actions) {
    const same = out.find((x) => x.action.ok === action.ok && x.action.label === action.label && (action.ok || x.action.detail === action.detail));
    if (same) same.times += 1; else out.push({ action, times: 1 });
  }
  return out;
}

/**
 * What the agent did in a turn, folded into one line under its reply: the reply is what the user reads, the
 * steps are there for whoever wants to check. It opens by itself only when a step on the video did not work.
 * Inside, the studio's changes first; the engine's own steps (commands, files, web) one fold deeper.
 */
function ActionList({ actions }: { actions: AgentActionLog[] }) {
  const own = actions.filter((a) => isOwnStep(a.tool));
  const studio = actions.filter((a) => !isOwnStep(a.tool));
  const failed = studio.filter((a) => !a.ok).length;
  const unfinished = own.filter((a) => !a.ok).length;
  const steps = (n: number) => (n === 1 ? translate("1 action") : translate("{0} actions", n));
  // What did not work says why, right under it: a red cross alone leaves the user guessing.
  const item = ({ action: a, times }: { action: AgentActionLog; times: number }, i: number) => <li key={i} data-ok={a.ok || undefined}>
    <EditorIcon name={a.ok ? "check" : "close"} />
    <span>{a.label}{times > 1 && <i> ×{times}</i>}{!a.ok && a.detail && <small>{a.detail}</small>}</span>
  </li>;
  const ownList = <ul className="chat-actions">{grouped(own).map(item)}</ul>;
  return <details className="chat-did" open={failed > 0}>
    <summary>
      <EditorIcon name="next" />
      <span>{translate("Changes made ·")} {steps(actions.length)}{failed > 0 && <b> · {failed === 1 ? translate("1 failed") : translate("{0} failed", failed)}</b>}</span>
    </summary>
    {studio.length > 0 && <ul className="chat-actions" aria-label={translate("Video changes")}>{grouped(studio).map(item)}</ul>}
    {own.length > 0 && (studio.length > 0
      ? <details className="chat-own-steps">
        <summary><EditorIcon name="next" /><span>{steps(own.length)} {own.length === 1 ? "interno" : "internos"}{translate("of the agent (commands, files, web)")}{unfinished ? translate(" · {0} not completed", unfinished) : ""}</span></summary>
        {ownList}
      </details>
      : ownList)}
  </details>;
}

/**
 * Claude Code or Codex asks before running a command or writing a file, as it would in a terminal: the
 * user sees exactly what, in plain words what answering means, and answers here. «Permitir todo hasta que
 * termine esta tarea» stops further questions until the turn ends.
 */
function ApprovalCard({ projectId, approval, engine }: { projectId: string; approval: AgentView["approvals"][number]; engine: string }) {
  type Answer = "allow" | "deny" | "all";
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = (next: Answer) => {
    setChoice(next);
    start(async () => {
      const result = await answerApprovalAction(projectId, approval.id, next !== "deny", next === "all").catch(failed(translate("The answer could not be sent.")));
      setError(result.ok ? null : result.error);
    });
  };
  // The answer that was pressed says it is on its way; the others only step back.
  const label = (mine: Answer, text: string) => (pending && choice === mine ? "Enviando…" : text);
  return <section className="chat-card chat-approval" aria-label={translate("Permission pending")}>
    <header><strong>{engine}{translate("needs your permission")}</strong><span>{approval.title}</span></header>
    {approval.detail && <pre>{approval.detail}</pre>}
    <p>{translate("If you don't recognize him, just go back to him and tell him what you prefer.")}</p>
    {/* The safe answer on the left, the one that goes ahead on the right; both the same size. */}
    <div className="chat-row">
      <button type="button" className="chat-secondary" disabled={pending} onClick={() => answer("deny")}>{label("deny", "Rechazar")}</button>
      <button type="button" className="chat-primary" disabled={pending} onClick={() => answer("allow")}>{label("allow", "Permitir")}</button>
    </div>
    <button type="button" className="chat-approval-all" disabled={pending} onClick={() => answer("all")}>{label("all", translate("Allow everything until this task is completed"))}</button>
    {error && <p className="chat-error" role="alert">{error}</p>}
  </section>;
}

/**
 * Stops the agent's turn; what it already changed stays, with its undo. It takes the send button's place
 * for as long as the agent works: the one control in the composer that still does something.
 */
function StopButton({ projectId, onError }: { projectId: string; onError: (message: string | null) => void }) {
  const [stopping, start] = useTransition();
  return <button type="button" className="chat-stop" disabled={stopping} title={translate("You can undo the changes already made")} onClick={() => start(async () => {
    const result = await cancelAgentTurnAction(projectId).catch(failed(translate("It couldn't stop.")));
    onError(result.ok ? null : result.error);
  })}>{stopping ? <span className="pro-spinner" /> : <i aria-hidden />}{stopping ? "Deteniendo…" : "Detener"}</button>;
}

/** The script the agent wrote, right in its reply: what each scene says, and a way into the editor. */
function ScriptCard({ project, onOpen }: { project: EditorProject; onOpen: () => void }) {
  // As the video will be: the real voice where it is up to date, else an estimate, plus each scene's pauses.
  const seconds = Math.round(totalOf(sceneSpans(project.scenes.map((s) => {
    const audio = project.audio[s.id];
    return sceneNarrationSeconds(s.narration, { durationSec: audio?.durationSec ?? null, upToDate: audio?.status === "ready" });
  }))));
  return <div className="chat-card chat-script">
    <header><EditorIcon name="script" /><strong>{translate("Script")}</strong><span>{project.scenes.length}{translate("scenes · ~")}{seconds} s</span></header>
    <ol>{project.scenes.map((s, i) => <li key={s.id}><span>{String(i + 1).padStart(2, "0")}</span><div><strong>{onScreenText(s.content)[0] || translate("Scene {0}", i + 1)}</strong><p>{s.narration}</p></div></li>)}</ol>
    <button type="button" onClick={onOpen}>{translate("Review and edit the script")}<EditorIcon name="next" /></button>
  </div>;
}

type StepState = "done" | "current" | "waiting";

/**
 * Script → voice → timeline → export, each step with its own action, so the user always knows what to press.
 * The script goes to the timeline as separate pieces (shots, voice, subtitles, music) to be seen and retouched;
 * a video file is only made at the end, from what is on the timeline. Once there is a montage the guide is
 * done: reviewing it and exporting are the project's next step, above the message box.
 */
function VideoGuide(p: Props & { blocked: boolean; onRun: (s: AgentSuggestion) => void; runningLabel: string | null }) {
  const { project } = p;
  const [voice, setVoice] = useState<string | null>(project.voiceId);
  const [savingVoice, startVoice] = useTransition();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [cancelling, startCancel] = useTransition();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const video = project.videos[0];
  const rendering = video && ["queued", "composing", "rendering"].includes(video.status);
  // One word each: four of them share a narrow row.
  const steps: { title: string; state: StepState }[] = [
    { title: translate("Script"), state: "done" },
    { title: translate("Voice"), state: project.voiceId ? "done" : "current" },
    { title: translate("Editing"), state: project.voiceId ? "current" : "waiting" },
    { title: translate("Export"), state: "waiting" },
  ];
  const current = steps.findIndex((s) => s.state === "current");
  function saveVoice() {
    setVoiceError(null);
    startVoice(async () => {
      const settings = { topic: project.topic, targetDurationSec: project.targetDurationSec, tone: project.tone, format: project.format, voiceId: voice, preset: project.preset, captionStyle: project.captionStyle, transition: project.transition, music: project.music, sfx: project.sfx };
      const result = await saveGenerationSettingsAction(project.id, settings).catch(failed(translate("You couldn't keep your voice.")));
      if (!result.ok) setVoiceError(result.error);
    });
  }
  // A render that is running (an older project rendering its script) shows in the timeline's step.
  const progress = rendering ? <>
    <div className="chat-progress"><div><strong>{PLAIN_STAGES[video.stage ?? ""] ?? STAGES[video.stage ?? ""] ?? translate("Preparing the video")}</strong><span>{Math.round(video.progress)}%</span></div><i><b style={{ width: `${Math.max(4, video.progress)}%` }} /></i></div>
    <p>{translate("It takes a few minutes, while you can keep working.")}</p>
    {cancelError && <p className="chat-error" role="alert">{cancelError}</p>}
    <button type="button" className="chat-secondary" disabled={cancelling} onClick={() => startCancel(async () => {
      const result = await cancelVideoAction(video.id).catch(failed(translate("It couldn't be canceled.")));
      setCancelError(result.ok ? null : result.error);
    })}>{cancelling ? "Cancelando…" : translate("Cancel")}</button>
  </> : null;
  return <section className="chat-card chat-guide" aria-label={translate("Next steps")}>
    <header><strong>{translate("Your video, step by step")}</strong><span>{translate("Step")} {current + 1}{translate("of")} {steps.length}</span></header>
    <ol className="chat-steps">{steps.map((s, i) => <li key={s.title} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}><span>{s.state === "done" ? <EditorIcon name="check" /> : i + 1}</span>{s.title}</li>)}</ol>
    {steps[1].state === "current" && <div className="chat-step-body">
      <p>{translate("Choose who narrates the video. Click to listen to each voice before deciding.")}</p>
      <VoicePicker value={voice} onChange={setVoice} />
      {voiceError && <p className="chat-error" role="alert">{voiceError}</p>}
      <button type="button" className="chat-primary" disabled={!voice || savingVoice || p.blocked} onClick={saveVoice}>{savingVoice ? translate("Saving…") : translate("Use this voice")}</button>
    </div>}
    {steps[2].state === "current" && <div className="chat-step-body">
      {progress ?? <>
        <p>{translate("Build the timeline to preview and adjust the shots, narration, subtitles, and music before export.")}</p>
        <button type="button" className="chat-primary" disabled={p.blocked} onClick={() => p.onRun({ label: translate("Build the timeline"), tool: "build_timeline", input: {} })}>{p.runningLabel === translate("Build the timeline") ? translate("Building timeline…") : translate("Build the timeline")}</button>
        <small>{translate("Building a timeline takes about a minute. You can export the video afterward.")}</small>
      </>}
    </div>}
    <button type="button" className="chat-link" onClick={() => p.onOpenScript(steps[1].state === "current" ? "settings" : "scenes")}><span>{steps[1].state === "current" ? translate("More voice and style settings") : translate("Review the script")}</span><EditorIcon name="next" /></button>
  </section>;
}

/**
 * Message box with attachments, the agent's permissions and send. It always says what to write next: the
 * placeholder follows the project (nothing yet, a script, a montage, a selection) and, while the box is
 * empty and nothing else is asking for an answer, a row of requests that make sense right now.
 */
function Composer(p: Props & { inputRef: RefObject<HTMLTextAreaElement | null>; onError: (message: string | null) => void }) {
  const ideas = !p.disabled && !p.prompt ? ideasFor(p) : [];
  const placeholder = p.agent.busy ? translate("{0} is working…", p.agent.provider.label)
    : p.disabled ? translate("Wait till I finish what's going on…")
    : p.selected ? translate("What change in what you have selected?")
    : p.hasMontage ? translate("Ask for a change, such as “trim the opening” or “add a title”…")
    : p.project.scenes.length ? translate("Ask for changes in the script or di \"generates the video...\"")
    : translate("Describe the video: theme, duration and tone…");
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AgentMode>(p.agent.permissions.mode);
  const [threshold, setThreshold] = useState(p.agent.permissions.threshold);
  const [saving, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const permissionsChanged = mode !== p.agent.permissions.mode || threshold !== p.agent.permissions.threshold;
  const summary = permissionSummary(p.agent.permissions.mode, p.agent.permissions.threshold);
  // The engine, model and effort live in the model picker; this pill keeps only the permissions.
  const picker = { choice: { provider: p.agent.provider.id, model: p.agent.choice.model, effort: p.agent.choice.effort }, statuses: p.agent.provider.statuses, apiModel: p.agent.choice.apiModel };
  function savePermissions() {
    start(async () => {
      const result = await setAgentPermissionsAction(mode, threshold).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : translate("Could not save.") }));
      if (!result.ok) setError(result.error); else setOpen(false);
    });
  }
  return <form className="pro-assistant-composer" onSubmit={(e) => { e.preventDefault(); p.onSend(); }}>
    {p.agent.provider.problem && <EngineProblem agent={p.agent} />}
    {p.selected && <span className="pro-context-chip">{translate("About your selection")}</span>}
    {ideas.length > 0 && <div className="chat-ideas" role="group" aria-label={translate("Ideas to order")}>
      {ideas.map((idea) => <button type="button" key={idea.label} title={idea.prompt} onClick={() => { p.onPrompt(idea.prompt); p.inputRef.current?.focus(); }}>{idea.label}</button>)}
    </div>}
    <textarea ref={p.inputRef} aria-label={translate("Ask the agent for changes")} value={p.prompt} onChange={(e) => p.onPrompt(e.target.value)} rows={2} maxLength={2000} disabled={p.disabled} placeholder={placeholder} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); p.onSend(); } }} />
    <div>
      <button type="button" className="chat-attach" aria-label={translate("Add files")} disabled={p.disabled} onClick={p.onImport}><EditorIcon name="plus" /></button>
      <AgentModelPicker initial={picker} busy={p.agent.busy} align="start" />
      <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) { setMode(p.agent.permissions.mode); setThreshold(p.agent.permissions.threshold); setError(null); } }}>
        <Popover.Trigger asChild><button type="button" className="chat-permissions" title={summary} aria-label={translate("Permissions of the agent: {0}", summary)}><span>{summary}</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg></button></Popover.Trigger>
        <Popover.Portal><Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12} className="ui-pop chat-permissions-pop">
          <h3>{translate("Agent permissions")}</h3>
          <p>{translate("Choose when you need your approval.")}</p>
          <AgentPermissionOptions mode={mode} threshold={threshold} disabled={saving} onMode={setMode} onThreshold={setThreshold} />
          {error && <p className="chat-error" role="alert">{error}</p>}
          <button type="button" className="chat-primary" disabled={!permissionsChanged || saving} onClick={savePermissions}>{saving ? translate("Saving…") : translate("Save changes")}</button>
        </Popover.Content></Popover.Portal>
      </Popover.Root>
      {p.agent.busy
        ? <StopButton projectId={p.project.id} onError={p.onError} />
        : <button type="submit" className="pro-send" aria-label={translate("Send the agent")} title={translate("Send (Intro) · Mayus + Intro for another line")} disabled={p.disabled || !p.prompt.trim()}><EditorIcon name="send" /></button>}
    </div>
  </form>;
}
