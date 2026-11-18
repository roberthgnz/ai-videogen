"use client";

import { t as translate } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/dropdown-menu";
import { estimateSeconds, MAX_SCENES } from "@/lib/script/schema";
import { convertContent, emptyContent } from "@/templates/registry";
import type { TemplateId } from "@/lib/domain";
import { EditorIcon } from "./desktop-controls";
import { initialEditorState, onScreenText, snapshot, toEditable, type SceneState } from "./editor-state";
import { generateScriptAction, generateVoiceAction, findVisualsAction, saveProjectAction, saveGenerationSettingsAction, sceneAudioAction, startVideoAction } from "./actions";
import { SettingsPanel } from "./settings-panel";
import { SceneInspector } from "./scene-inspector";
import { SceneAudio, VOICE_STATUS } from "./scene-audio";
import { SceneShots } from "./scene-shots";
import { narrationSeconds, sceneSpans, totalOf } from "./timeline-math";
import type { EditorProject } from "./types";
import "./script-tools.css";

/**
 * The script, to read and to fix by hand. It reads top to bottom like a document: one card per scene with
 * what the voice says, and the scene that is being edited opens right there, in its own card (never at the
 * end of the list, where it would be off screen). What is not saved says so in a bar with its two ways out,
 * and the panel has one main action; the rest are one level down, in «Más».
 */
export function ScriptTools({ project, disabled, onLoadVideo, onDirtyChange, tab: shownTab, onTabChange, onFocusScene }: { project: EditorProject; disabled: boolean; onLoadVideo: () => void; onDirtyChange: (dirty: boolean) => void; tab?: "scenes" | "settings"; onTabChange?: (tab: "scenes" | "settings") => void; onFocusScene?: (index: number, span: { start: number; duration: number }, force?: boolean) => void }) {
  const router = useRouter();
  const initial = useMemo(() => initialEditorState(project), [project]);
  const [draft, setDraft] = useState(initial);
  const [synced, setSynced] = useState(snapshot(initial));
  const [incoming, setIncoming] = useState(snapshot(initial));
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the last save found wrong, by scene position: shown on the scene itself. */
  const [issues, setIssues] = useState<Record<number, string[]>>({});
  const [rewriteAsk, setRewriteAsk] = useState(false);
  const [pending, startTransition] = useTransition();
  const [ownTab, setOwnTab] = useState<"scenes" | "settings">("scenes");
  // The studio can open a tab from outside (the agent's «Elegir voz»); otherwise the tabs are local.
  const tab = shownTab ?? ownTab;
  const setTab = (next: "scenes" | "settings") => { setOwnTab(next); onTabChange?.(next); };
  const dirty = snapshot(draft) !== synced;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const source = snapshot(initial);
  if (source !== incoming) {
    if (!dirty) { setDraft(initial); setSynced(source); }
    setIncoming(source);
  }
  const audioBusy = Object.values(project.audio).some((audio) => audio.status === "running");
  useEffect(() => {
    if (!audioBusy) return;
    const timer = setInterval(() => router.refresh(), 1200);
    return () => clearInterval(timer);
  }, [audioBusy, router]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  // The scene that was opened comes into view: a long one above it may have pushed it out.
  useEffect(() => {
    if (selected) document.getElementById(`script-scene-${selected}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const scene = draft.scenes.find((item) => item.key === selected);
  const index = scene ? draft.scenes.indexOf(scene) : -1;
  const blocked = disabled || pending;
  const topic = draft.settings.topic.trim();
  const savedNarration = (id: string | undefined) => (id ? project.scenes.find((item) => item.id === id)?.narration : undefined);
  // As the video will be: the real voice where it still says what the script says, else an estimate.
  const spans = useMemo(() => sceneSpans(draft.scenes.map((item) => {
    const audio = item.id ? project.audio[item.id] : undefined;
    return narrationSeconds(item.narration, { durationSec: audio?.durationSec ?? null, upToDate: audio?.status === "ready" && savedNarration(item.id) === item.narration });
  })), [draft.scenes, project.audio, project.scenes]);
  const seconds = Math.round(totalOf(spans));

  const prevSelection = useRef<string | null>(null);
  useEffect(() => {
    if (selected && index >= 0 && spans[index]) {
      const keyWithIndex = `${selected}:${index}`;
      if (prevSelection.current !== keyWithIndex) {
        prevSelection.current = keyWithIndex;
        onFocusScene?.(index, spans[index], true);
      }
    } else if (!selected) {
      prevSelection.current = null;
    }
  }, [selected, index, spans, onFocusScene]);
  async function save() {
    const result = draft.scenes.length
      ? await saveProjectAction(project.id, { settings: draft.settings, script: { title: draft.title || project.topic || translate("My video"), scenes: draft.scenes.map(toEditable) } })
      : await saveGenerationSettingsAction(project.id, draft.settings);
    if (!result.ok) {
      // Open the first scene that has a problem: the reason is written on it.
      const found = result.sceneIssues ?? {};
      const first = Object.keys(found).map(Number).sort((a, b) => a - b)[0];
      setIssues(found);
      if (first !== undefined && draft.scenes[first]) setSelected(draft.scenes[first].key);
      throw new Error(result.error);
    }
    setIssues({});
    setSynced(snapshot(draft));
  }
  function run(action: () => Promise<{ ok: boolean; error?: string }>, saveFirst = true, replace = false) {
    startTransition(async () => {
      setError(null);
      try {
        if (saveFirst) await save();
        if (replace) setSynced(snapshot(draft));
        const result = await action();
        if (!result.ok) throw new Error(result.error);
        router.refresh();
      } catch (error) {
        if (replace) setSynced(synced);
        setError(error instanceof Error ? error.message : translate("The operation could not be completed."));
      }
    });
  }
  function patch(patch: Partial<SceneState>) { setDraft((current) => ({ ...current, scenes: current.scenes.map((item) => item.key === selected ? { ...item, ...patch } : item) })); }
  function addScene() {
    const key = crypto.randomUUID();
    setDraft((current) => ({ ...current, scenes: [...current.scenes, { key, template: "text", narration: "", content: emptyContent("text"), visualQueries: "" }] }));
    setSelected(key);
  }
  function move(delta: -1 | 1) {
    const target = index + delta;
    if (index < 0 || target < 0 || target >= draft.scenes.length) return;
    const scenes = [...draft.scenes];
    [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
    setDraft({ ...draft, scenes });
    setIssues({});
  }
  function remove() {
    setDraft({ ...draft, scenes: draft.scenes.filter((item) => item.key !== selected) });
    setSelected(null);
    setIssues({});
  }
  /** Back to what is saved: the way out of an edit (or a removed scene) the user did not mean. */
  function discard() {
    setDraft(initial);
    setSelected(null);
    setError(null);
    setIssues({});
  }
  const rewrite = () => run(() => generateScriptAction(project.id, draft.settings), false, true);
  const hasVideo = project.videos.some((video) => video.status === "done");
  const problem = error ?? project.scriptError;

  return <div className="unified-script-tools">
    <div className="unified-tabs" role="tablist" aria-label={translate("Screenplay tools")}>
      <button type="button" role="tab" aria-selected={tab === "scenes"} onClick={() => setTab("scenes")}>{translate("Scenes")}</button>
      <button type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>{translate("Voice and style")}</button>
    </div>
    <div className="unified-script-content">
      {/* What went wrong, where it is seen: at the top, not under a list that scrolls. */}
      {problem && <p role="alert" className="script-error">{problem}</p>}
      {tab === "settings" ? <SettingsPanel settings={draft.settings} onChange={(settings) => setDraft({ ...draft, settings })} audioLibrary={project.audioLibrary} readOnly={blocked} /> : draft.scenes.length === 0 ? <div className="script-empty">
        <span><EditorIcon name="script" /></span>
        <h3>{translate("No script yet")}</h3>
        <p>{translate("Ask the agent in the chat, with your words, or write it here scene by scene.")}</p>
        <Button variant="primary" size="sm" disabled={blocked || !topic} onClick={rewrite}>{pending ? "Escribiendo…" : translate("Write the script with IA")}</Button>
        {!topic && <small>{translate("Before I said what the video is about in")} <button type="button" onClick={() => setTab("settings")}>{translate("Voice and style")}</button>.</small>}
        <Button variant="outline" size="sm" disabled={blocked} onClick={addScene}>{translate("Add a scene by hand")}</Button>
      </div> : <>
        <p className="script-summary"><strong>{draft.scenes.length === 1 ? translate("1 scene") : translate("{0} scenes", draft.scenes.length)}</strong><span>{translate("about")}{seconds}{translate("s · target")} {draft.settings.targetDurationSec} s</span></p>
        <ol className="script-scenes">
          {draft.scenes.map((item, number) => {
            const open = item.key === selected;
            const voice = VOICE_STATUS[(item.id ? project.audio[item.id]?.status : undefined) ?? "none"];
            const images = item.id ? (project.shots[item.id] ?? []).length : 0;
            return <li key={item.key} id={`script-scene-${item.key}`} className="script-scene" data-open={open || undefined} data-issue={issues[number]?.length ? true : undefined}
              onFocusCapture={() => { if (spans[number]) onFocusScene?.(number, spans[number], false); }}
              onPointerDownCapture={() => { if (open && spans[number]) onFocusScene?.(number, spans[number], false); }}>
              <button type="button" className="script-scene-head" aria-expanded={open} onClick={() => setSelected(open ? null : item.key)}>
                <span>{String(number + 1).padStart(2, "0")}</span>
                <span>
                  <strong>{onScreenText(item.content)[0] || translate("Scene {0}", number + 1)}</strong>
                  {/* Closed, the card is the script itself: what is said, and how the scene stands. */}
                  {!open && <small>{item.narration || translate("He's not saying anything yet.")}</small>}
                  {!open && <i data-tone={voice.tone}>{voice.label}{images > 0 ? ` · ${images === 1 ? translate("1 image") : translate("{0} images", images)}` : ""}</i>}
                </span>
                <em>~{Math.round(estimateSeconds(item.narration))} s</em>
                <EditorIcon name="next" />
              </button>
              {open && scene && <div className="script-scene-body"><SceneInspector index={index} count={draft.scenes.length} scene={scene} issues={issues[number]} readOnly={blocked}
                onChange={patch} onTemplate={(template: TemplateId) => patch({ template, content: convertContent(scene.template, scene.content, template) })}
                onMove={move} onRemove={remove}
                shots={scene.id && images > 0 ? <SceneShots projectId={project.id} sceneId={scene.id} shots={project.shots[scene.id] ?? []} credit={project.visuals.credit} disabled={blocked || dirty} /> : null}
                shotsHint={scene.id ? translate("This scene has no images yet. They are sought alone when generating the video, or now with \"More › Search for images.\"") : translate("Save the changes to be able to search for images for this scene.")}
                audio={<SceneAudio info={scene.id ? project.audio[scene.id] : undefined} unsaved={!scene.id || savedNarration(scene.id) !== scene.narration} busy={blocked} onGenerate={(force) => { if (scene.id) run(() => sceneAudioAction(project.id, scene.id!, force)); }} />}
                preview={scene.id ? <Button size="sm" variant="outline" className="script-preview" disabled={blocked || dirty} title={dirty ? "Guarda los cambios primero" : translate("A quick draft of this scene alone")} onClick={() => run(() => startVideoAction(project.id, { source: "script", sceneId: scene.id, quality: "draft" }))}>{translate("See how this scene is left")}</Button> : null} /></div>}
            </li>;
          })}
        </ol>
        <Button variant="outline" size="sm" className="script-add" disabled={blocked || draft.scenes.length >= MAX_SCENES} title={draft.scenes.length >= MAX_SCENES ? translate("A script has at most {0} scenes", MAX_SCENES) : undefined} onClick={addScene}><EditorIcon name="plus" />{translate("Add Scene")}</Button>
      </>}
    </div>
    <div className="script-bar">
      {dirty && <div className="script-save" role="status">
        <span>{translate("Unsaved changes")}</span>
        <Button variant="ghost" size="sm" disabled={blocked} onClick={discard}>{translate("Discard")}</Button>
        <Button variant="primary" size="sm" disabled={blocked} onClick={() => run(async () => { await save(); return { ok: true }; }, false)}>{pending ? translate("Saving…") : translate("Save")}</Button>
      </div>}
      <div className="script-actions">
        <Button variant="primary" size="sm" disabled={blocked || !draft.scenes.length} onClick={() => run(() => startVideoAction(project.id, { source: "script" }))}>{translate("Generate video of the script")}</Button>
        <Menu>
          <MenuTrigger asChild><Button variant="outline" size="sm" aria-label={translate("More actions of the script")}>{translate("More")}</Button></MenuTrigger>
          <MenuContent side="top" className="min-w-[250px]">
            <MenuItem disabled={blocked || !draft.scenes.length || audioBusy} onSelect={() => run(() => generateVoiceAction(project.id))}>
              <span className="flex flex-col"><span>{audioBusy ? translate("Generating the voice…") : translate("Generate the voice")}</span><span className="text-xs text-muted">{translate("Of all the scenes")}</span></span>
            </MenuItem>
            <MenuItem disabled={blocked || !draft.scenes.length} onSelect={() => run(() => findVisualsAction(project.id))}>
              <span className="flex flex-col"><span>{translate("Find images")}</span><span className="text-xs text-muted">{translate("For all the scenes")}</span></span>
            </MenuItem>
            {hasVideo && <MenuItem disabled={blocked} onSelect={onLoadVideo}>
              <span className="flex flex-col"><span>{translate("Take the video to the timeline")}</span><span className="text-xs text-muted">{translate("The last one that was generated")}</span></span>
            </MenuItem>}
            <MenuSeparator />
            <MenuItem disabled={blocked || !topic} onSelect={() => { if (draft.scenes.length) setRewriteAsk(true); else rewrite(); }}>
              <span className="flex flex-col"><span>{draft.scenes.length ? translate("Rewrite the script with IA…") : translate("Write the script with IA")}</span><span className="text-xs text-muted">{topic ? translate("From the theme of \"Voice and style\"") : translate("The theme is missing in \"Voice and style\"")}</span></span>
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
    {/* The app's own dialog: native confirm() is not available in every desktop webview. */}
    <ConfirmDialog open={rewriteAsk} onOpenChange={setRewriteAsk} title={translate("Rewrite the script?")}
      description={translate("A new script with IA is written and replaced {0}. It cannot be undone.", draft.scenes.length === 1 ? translate("the current scene") : translate("the {0} current scenes", draft.scenes.length))}
      confirmLabel="Volver a escribirlo" onConfirm={() => { setRewriteAsk(false); rewrite(); }} />
  </div>;
}
