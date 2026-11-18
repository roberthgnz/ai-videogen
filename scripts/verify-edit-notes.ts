import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EditDocument, EditOverlay } from "../src/lib/editing/schema";
import type { AgentContext } from "../src/lib/agent/tools";

// No personal database, settings, media, conversations or API keys are used by these fixtures.
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "videogen-seven-notes-"));
  process.env.STORAGE_DIR = root;
  process.env.VIDEOGEN_DESKTOP = "0";
  for (const key of ["ANTHROPIC_API_KEY", "FISH_AUDIO_API_KEY", "ELEVENLABS_API_KEY", "PIXABAY_API_KEY"]) delete process.env[key];
  const { editDocumentSchema, newOverlay } = await import("../src/lib/editing/schema");
  const { runFfmpeg } = await import("../src/lib/media/ffmpeg");
  const { runToolDirect, defaultDeps, noteReviewOutcome, toolByName } = await import("../src/lib/agent/tools");
  const { getDb, schema } = await import("../src/lib/db");
  const { getProject, listAgentMessages } = await import("../src/lib/projects");
  const { saveEditDocument } = await import("../src/lib/editing/repository");
  const { readNoteReview, saveNoteReview } = await import("../src/lib/editing/note-review");
  const { accumulateNoteReview, pendingNotePages } = await import("../src/lib/editing/notes");
  const { notePreviewPage } = await import("../src/lib/editing/note-preview");
  const { textBox } = await import("../src/lib/editing/text-preview");
  const { planEditComposition } = await import("../src/lib/editing/composition");
  await fs.mkdir(path.join(root, "media"));
  const png = path.join(root, "media", "speaker.png");
  await runFfmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x203040:s=540x960",
    "-vf", "drawbox=x=180:y=220:w=180:h=230:color=0xd6a77a:t=fill,drawbox=x=210:y=280:w=20:h=20:color=black:t=fill,drawbox=x=310:y=280:w=20:h=20:color=black:t=fill,drawbox=x=235:y=365:w=70:h=12:color=black:t=fill,drawbox=x=125:y=450:w=290:h=510:color=0x426c85:t=fill",
    "-frames:v", "1", png]);
  for (const [file, frequency, duration] of [["voice.wav", 500, 12], ["music.wav", 220, 12], ["hit.wav", 90, 0.3]] as const) {
    await runFfmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${duration}:sample_rate=48000`, path.join(root, "media", file)]);
  }
  const paths = [png, ...["voice.wav", "music.wav", "hit.wav"].map((name) => path.join(root, "media", name))];
  const hashes = await Promise.all(paths.map(async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")));
  const overlay = (id: string, text: string, start: number, duration: number, extra: Partial<EditOverlay> = {}) => ({
    ...newOverlay(text, start, duration), id, x: 10, y: 12, width: 80, fontSize: 64,
    color: "#ffffff", background: "transparent", fontFamily: "sans" as const, track: 0, ...extra,
  });
  const base = (): EditDocument => editDocumentSchema.parse({
    enabled: true, revision: 0, duration: 12, background: "#203040",
    direction: { voiceover: false, captions: true, titles: true, music: true, sfx: true },
    assets: [
      { id: "picture", name: "Persona a cámara", kind: "image", path: "media/speaker.png", duration: 0, width: 540, height: 960, hasAudio: false },
      { id: "voice", name: "Locución original", kind: "audio", path: "media/voice.wav", duration: 12, width: 0, height: 0, hasAudio: true, context: "Voz original; no es música ni efecto. Audio sintético de prueba, no contiene habla real." },
      { id: "music", name: "Música de fondo", kind: "audio", path: "media/music.wav", duration: 12, width: 0, height: 0, hasAudio: true, context: "Música, conservar salvo petición específica." },
      { id: "hit", name: "Efecto · golpe.wav", kind: "audio", path: "media/hit.wav", duration: 0.3, width: 0, height: 0, hasAudio: true, context: "Efecto de golpe disponible para sincronizar con gráficos." },
    ],
    clips: [
      { id: "picture-a", assetId: "picture", start: 0, in: 0, duration: 6, volume: 0, fit: "cover", transition: "cut", motion: "push", track: 0 },
      { id: "picture-b", assetId: "picture", start: 6, in: 0, duration: 6, volume: 0, fit: "cover", transition: "fade", motion: "pull", track: 0 },
      { id: "voice-clip", assetId: "voice", start: 0, in: 0, duration: 12, volume: 0.9, fit: "contain", transition: "cut", motion: "none", track: 0 },
      { id: "music-clip", assetId: "music", start: 0, in: 0, duration: 12, volume: 0.18, fit: "contain", transition: "cut", motion: "none", track: 1 },
      { id: "sfx-a", assetId: "hit", start: 3, in: 0, duration: 0.3, volume: 0.4, fit: "contain", transition: "cut", motion: "none", track: 2 },
      { id: "sfx-b", assetId: "hit", start: 7, in: 0, duration: 0.3, volume: 0.2, fit: "contain", transition: "cut", motion: "none", track: 2 },
    ],
    overlays: [overlay("hook", "Aprende a editar", 0, 2), overlay("closing", "Guárdalo para después", 10, 2, { y: 65 })],
    references: [{ id: "brand-guide", title: "Mi guía de estilo", roles: ["brand"], content: "Todos los textos y subtítulos: color #1177cc y familia serif. Conserva contenido, posiciones, tamaño y tiempos; solo corregimos colores y fuentes.", url: "" }],
  });
  type Scenario = {
    id: string; note: string; doc: EditDocument;
    patch: Record<string, unknown>;
    allowed: Record<string, string[]>; removed?: string[]; additions?: { clips?: number; overlays?: number };
    check: (before: EditDocument, after: EditDocument) => void;
  };
  const withOverlays = (...items: EditOverlay[]) => ({ ...base(), overlays: [...base().overlays, ...items] });
  const scenarios: Scenario[] = [
    { id: "encuadre", note: "Ese gráfico me tapa la cara. Súbelo y deja mi cara libre.",
      doc: withOverlays(overlay("face-card", "Consejo importante", 4, 4, { y: 30 })),
      patch: { overlays: [{ id: "face-card", set: { y: 12 } }] }, allowed: { "face-card": ["y", "x", "width", "fontSize"] },
      check: (before, after) => {
        const item = after.overlays.find((o) => o.id === "face-card")!;
        assert(item.y < before.overlays.find((o) => o.id === item.id)!.y, "el rótulo debe subir");
        const box = textBox(item, true);
        assert(box.y + box.h < 22 || box.x + box.w < 30 || box.x > 70, "el rótulo sigue sobre la cara, incluso con margen para el zoom");
      } },
    { id: "limpieza", note: "Hay demasiadas cosas en pantalla. Una idea cada vez.",
      doc: withOverlays(overlay("idea-a", "Primera idea", 4, 2, { y: 55 }), overlay("idea-b", "Segunda idea", 4, 2, { y: 65 })),
      patch: { overlays: [{ id: "idea-b", set: { start: 6 } }] }, allowed: { "idea-a": ["start", "duration"], "idea-b": ["start", "duration"] },
      check: (_before, after) => {
        const a = after.overlays.find((o) => o.id === "idea-a")!, b = after.overlays.find((o) => o.id === "idea-b")!;
        assert(a.start + a.duration <= b.start || b.start + b.duration <= a.start, "las dos ideas siguen simultáneas");
      } },
    { id: "sincronia", note: "El gráfico entra tarde. Adelántalo 3 fotogramas.",
      doc: withOverlays(overlay("late-card", "Ahora", 4.2, 1.5, { y: 55 })),
      patch: { overlays: [{ id: "late-card", shiftFrames: -3 }] }, allowed: { "late-card": ["start"] },
      check: (before, after) => assert(Math.abs(before.overlays.find((o) => o.id === "late-card")!.start - after.overlays.find((o) => o.id === "late-card")!.start - 0.1) < 1e-9, "debe adelantar exactamente 3 fotogramas") },
    { id: "subtitulos", note: "Los subtítulos van muy rápido. Cada uno, al menos 0,4 s.",
      doc: withOverlays(...["Hola", "qué", "tal", "estás"].map((word, index) => overlay(`caption-${index}`, word, 4 + index * 0.2, 0.2, { kind: "caption", y: 65, fontSize: 48 }))),
      patch: { overlays: [{ id: "caption-0", set: { text: "Hola qué", duration: 0.4 } }, { id: "caption-2", set: { text: "tal estás", duration: 0.4 } }], removeOverlayIds: ["caption-1", "caption-3"] },
      allowed: Object.fromEntries([0, 1, 2, 3].map((index) => [`caption-${index}`, ["text", "start", "duration"]])), removed: ["caption-1", "caption-3"],
      check: (_before, after) => {
        const captions = after.overlays.filter((o) => o.kind === "caption").sort((a, b) => a.start - b.start);
        assert(captions.every((o) => o.duration >= 0.4 - 1e-9), "hay subtítulos menores de 0,4 s");
        assert.equal(captions.map((o) => o.text).join(" "), "Hola qué tal estás", "se han perdido o duplicado palabras");
        assert(Math.abs(captions[0].start - 4) < 1e-9 && Math.abs(captions.at(-1)!.start + captions.at(-1)!.duration - 4.8) < 1e-9, "cambió el tramo de habla");
        for (let i = 1; i < captions.length; i++) assert(captions[i - 1].start + captions[i - 1].duration <= captions[i].start + 1e-9, "hay solapamientos");
      } },
    { id: "estilo", note: "Esto no sigue mi guía de estilo. Revísala y corrige colores y fuentes.",
      doc: withOverlays(overlay("body-caption", "Hola", 4, 1, { kind: "caption", y: 65, fontSize: 48 })),
      patch: { overlays: ["hook", "closing", "body-caption"].map((id) => ({ id, set: { color: "#1177cc", fontFamily: "serif" } })) },
      allowed: Object.fromEntries(["hook", "closing", "body-caption"].map((id) => [id, ["color", "fontFamily"]])),
      check: (_before, after) => { for (const item of after.overlays) { assert.equal(item.color.toLowerCase(), "#1177cc"); assert.equal(item.fontFamily, "serif"); } } },
    { id: "sonido", note: "Los efectos están muy fuertes. Bájalos a la mitad.", doc: base(),
      patch: { clips: [{ id: "sfx-a", volumeFactor: 0.5 }, { id: "sfx-b", volumeFactor: 0.5 }] }, allowed: { "sfx-a": ["volume"], "sfx-b": ["volume"] },
      check: (before, after) => { for (const id of ["sfx-a", "sfx-b"]) assert.equal(after.clips.find((c) => c.id === id)!.volume, before.clips.find((c) => c.id === id)!.volume / 2); } },
    { id: "gancho", note: "Que el gancho pegue más: primera palabra más grande y un golpe en el primer fotograma.", doc: base(),
      patch: { overlays: [{ id: "hook", set: { text: "a editar", y: 55 } }], addOverlays: [{ ...overlay("unused", "Aprende", 0, 2, { fontSize: 96 }), id: undefined }],
        addClips: [{ assetId: "hit", start: 0, in: 0, duration: 0.3, volume: 0.35, fit: "contain", transition: "cut", motion: "none", track: 3 }] },
      allowed: { hook: ["text", "x", "y", "width", "fontSize"] }, additions: { clips: 1, overlays: 1 },
      check: (before, after) => {
        const word = after.overlays.find((o) => !before.overlays.some((old) => old.id === o.id))!;
        assert.equal(word.text, "Aprende"); assert.equal(word.start, 0);
        assert(word.fontSize > after.overlays.find((o) => o.id === "hook")!.fontSize, "la primera palabra debe ser mayor que el resto");
        assert.equal(after.overlays.find((o) => o.id === "hook")!.text, "a editar", "la primera palabra quedó duplicada");
        const hit = after.clips.find((c) => !before.clips.some((old) => old.id === c.id))!;
        assert.equal(hit.assetId, "hit"); assert.equal(hit.start, 0); assert.equal(hit.in, 0);
      } },
  ];
  // Omit generated IDs: add operations allocate their own identifiers.
  const hookAdditions = scenarios.at(-1)!.patch.addOverlays as Record<string, unknown>[];
  delete hookAdditions[0].id;
  const outsideFrame = await notePreviewPage(base(), true, [9.5], []);
  assert(outsideFrame.image && !outsideFrame.failures.length, "no se pudo crear el fotograma de control exterior");

  const untouched = (before: EditDocument, after: EditDocument, scenario: Scenario, generated = false) => {
    const metadata = (doc: EditDocument) => Object.fromEntries(Object.entries(doc).filter(([key]) => !["revision", "clips", "overlays"].includes(key)));
    assert.deepEqual(metadata(after), metadata(before), "cambiaron ajustes, archivos, referencias, fondo o duración");
    for (const kind of ["clips", "overlays"] as const) {
      const oldItems = before[kind], newItems = after[kind];
      const flexibleCaptions = generated && scenario.id === "subtitulos" && kind === "overlays";
      const removed = new Set(flexibleCaptions
        ? oldItems.filter((item) => item.id.startsWith("caption-") && !newItems.some((current) => current.id === item.id)).map((item) => item.id)
        : scenario.removed ?? []);
      for (const oldItem of oldItems) {
        const current = newItems.find((item) => item.id === oldItem.id);
        if (removed.has(oldItem.id)) { assert(!current, `no se eliminó ${oldItem.id}`); continue; }
        assert(current, `se perdió ${oldItem.id}`);
        const allowed = new Set(scenario.allowed[oldItem.id] ?? []);
        const omit = (item: object) => Object.fromEntries(Object.entries(item).filter(([key]) => !allowed.has(key)));
        assert.deepEqual(omit(current), omit(oldItem), `cambios ajenos a la nota en ${oldItem.id}`);
      }
      assert.deepEqual(newItems.filter((item) => oldItems.some((old) => old.id === item.id)).map((item) => item.id), oldItems.filter((item) => !removed.has(item.id)).map((item) => item.id), "se alteró el orden de elementos existentes");
      const added = newItems.filter((item) => !oldItems.some((old) => old.id === item.id));
      if (flexibleCaptions) assert(added.every((item) => "kind" in item && item.kind === "caption"), "solo se pueden añadir subtítulos al reagruparlos");
      else assert.equal(added.length, scenario.additions?.[kind] ?? 0, "adiciones inesperadas");
    }
  };
  const create = (id: string, doc: EditDocument) => {
    getDb().insert(schema.projects).values({ id, title: `Prueba ${id}`, format: "vertical", edit: doc }).run();
  };
  const context = (id: string): AgentContext => ({ projectId: id, deps: defaultDeps, suggestions: [] });
  const report: { name: string; status: string; detail?: unknown }[] = [];
  const check = async (name: string, run: () => Promise<unknown> | unknown) => {
    try { const detail = await run(); report.push({ name, status: "PASS", detail }); console.log(`PASS ${name}`); }
    catch (error) { report.push({ name, status: "FAIL", detail: error instanceof Error ? error.stack : String(error) }); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  };
  for (const scenario of scenarios) await check(`tools/${scenario.id}`, async () => {
    create(scenario.id, scenario.doc);
    const ctx = context(scenario.id);
    const before = structuredClone(getProject(scenario.id)!.edit);
    const result = await runToolDirect("apply_edit_notes", { expectedRevision: before.revision, ...scenario.patch }, ctx);
    assert(result.ok, result.ok ? "" : result.error);
    const after = getProject(scenario.id)!.edit;
    untouched(before, after, scenario); scenario.check(before, after);
    assert.equal(after.revision, before.revision + 1);
    const outside = await notePreviewPage(after, true, [9.5], []);
    assert.deepEqual(outside.failures, []);
    assert.equal(outside.image, outsideFrame.image, "cambió la imagen fuera de los intervalos afectados");
    const stale = await runToolDirect("apply_edit_notes", { expectedRevision: before.revision, ...scenario.patch }, ctx);
    assert(!stale.ok, "un reintento antiguo debe fallar"); assert.deepEqual(getProject(scenario.id)!.edit, after);
    const review = readNoteReview(scenario.id)!;
    assert.equal(review.revision, after.revision);
    const exported = planEditComposition(after, "vertical", "Prueba").files.get("index.html");
    assert.equal(typeof exported, "string");
    assert((exported as string).includes('data-volume="0.9"'), "se alteró la voz en la composición exportable");
    const pending = pendingNotePages(review);
    if (pending.length) {
      assert(noteReviewOutcome(ctx)?.includes("revisar"));
      const premature = await runToolDirect("propose_actions", { message: "La nota está terminada.", actions: [{ label: "Exportar", tool: "generate_video", input: {} }] }, ctx);
      assert(!premature.ok, "no puede dar la nota por revisada antes de ver los lotes");
    }
    return { affected: ctx.noteReview!.changes.map((c) => c.id), frames: review.times.length, unchanged: "all other fields and elements" };
  });

  await check("integration/real-ffmpeg-review-and-resume", async () => {
    const id = "encuadre", before = structuredClone(getProject(id)!.edit), ctx = context(id);
    const first = await runToolDirect("review_edit_notes", { expectedRevision: before.revision, page: 0 }, ctx);
    assert(first.ok, first.ok ? "" : first.error);
    assert(ctx.images?.length, "faltan imágenes reales de revisión");
    assert.equal(ctx.noteReview!.unavailable.size, 0, first.ok ? first.message : "");
    await fs.writeFile(path.join(root, "review-first.jpg"), Buffer.from(ctx.images![0], "base64"));
    const checkpoint = readNoteReview(id)!;
    assert(checkpoint.reviewed.has(0));
    // A fresh context represents a new turn/app restart, not a reused in-memory Set.
    const resumed = context(id);
    for (const page of pendingNotePages(checkpoint)) {
      resumed.images = [];
      const result = await runToolDirect("review_edit_notes", { expectedRevision: before.revision, page }, resumed);
      assert(result.ok, result.ok ? "" : result.error);
      assert.equal(resumed.noteReview!.unavailable.size, 0, result.ok ? result.message : "");
    }
    assert.equal(pendingNotePages(readNoteReview(id)!).length, 0);
    assert.deepEqual(getProject(id)!.edit, before, "revisar modificó el montaje");
    return { image: path.join(root, "review-first.jpg"), batches: checkpoint.reviewed.size + pendingNotePages(checkpoint).length };
  });
  await check("safety/range-and-atomic-errors", async () => {
    const id = "range", doc = scenarios[2].doc; create(id, doc);
    const before = structuredClone(getProject(id)!.edit), ctx = context(id);
    for (const input of [
      { overlays: [{ id: "late-card", set: { color: "#aabbcc" } }, { id: "missing", set: { y: 5 } }] },
      { range: { from: 4.4, to: 5 }, overlays: [{ id: "late-card", shiftFrames: -3 }] },
      { clips: [{ id: "sfx-a", volumeFactor: 0.5 }, { id: "sfx-a", volumeFactor: 0.5 }] },
      { overlays: [{ id: "late-card", shiftFrames: -300 }] },
      { clips: [{ id: "sfx-a", set: { assetId: "music" } }] },
    ]) {
      const result = await runToolDirect("apply_edit_notes", { expectedRevision: before.revision, ...input }, ctx);
      assert(!result.ok, "se aceptó un parche fuera de alcance o inválido"); assert.deepEqual(getProject(id)!.edit, before);
    }
    const result = await runToolDirect("apply_edit_notes", { expectedRevision: before.revision, range: { from: 4, to: 7 }, overlays: [{ id: "late-card", shiftFrames: -3 }] }, ctx);
    assert(result.ok, result.ok ? "" : result.error);
    const saved = structuredClone(getProject(id)!.edit);
    const widen = await runToolDirect("apply_edit_notes", { expectedRevision: saved.revision, range: { from: 0, to: 12 }, overlays: [{ id: "hook", set: { color: "#ff0000" } }] }, ctx);
    assert(!widen.ok); assert.deepEqual(getProject(id)!.edit, saved);
  });
  await check("safety/protect-rebuild-and-review-cancellation", async () => {
    const id = "sincronia", doc = structuredClone(getProject(id)!.edit), ctx = context(id);
    ctx.noteReview = readNoteReview(id);
    for (const name of ["edit_workspace", "place_text", "build_timeline", "sync_music_to_beats", "set_style", "analyze_media"]) {
      await assert.rejects(async () => toolByName(name)!.run({} as never, ctx), /modo de retoque/);
      assert.deepEqual(getProject(id)!.edit, doc);
    }
    const abort = new AbortController(); abort.abort();
    await assert.rejects(notePreviewPage(doc, true, [4.1], ctx.noteReview!.changes, abort.signal));
    assert.deepEqual(getProject(id)!.edit, doc);
  });
  await check("safety/review-invalidated-after-correction", () => {
    const saved = readNoteReview("encuadre")!, doc = getProject("encuadre")!.edit;
    saved.reviewed.add(0);
    const changed = { ...doc.overlays.find((o) => o.id === "face-card")!, y: 11 };
    const next = accumulateNoteReview(saved, { ...doc, revision: doc.revision + 1 }, [{ kind: "overlay", id: changed.id, before: doc.overlays.find((o) => o.id === changed.id), after: changed, fields: ["y"] }]);
    assert.equal(next.reviewed.size, 0); assert(pendingNotePages(next).length);
    saveNoteReview("encuadre", saved);
  });
  await check("safety/concurrent-revision-is-not-overwritten", async () => {
    const id = "sonido", before = getProject(id)!.edit;
    const saved = saveEditDocument(id, { ...before, background: "#112233" });
    const result = await runToolDirect("apply_edit_notes", { expectedRevision: before.revision, clips: [{ id: "sfx-a", volumeFactor: 0.5 }] }, context(id));
    assert(!result.ok); assert.deepEqual(getProject(id)!.edit, saved);
  });
  const selectedAgentCases = process.argv.find((arg) => arg.startsWith("--agent-cases="))?.split("=")[1].split(",");
  if (process.argv.includes("--agent") || selectedAgentCases) {
    const { saveAppSettings } = await import("../src/lib/app-settings");
    const { startAgentTurn, isAgentBusy, liveAgentStep, cancelAgentTurn } = await import("../src/lib/agent/run");
    // Use the installed, signed-in provider through the actual application entry point.
    assert(saveAppSettings({ agentProvider: "codex", agentMode: "auto" }).ok);
    for (const scenario of scenarios.filter((s) => !selectedAgentCases || selectedAgentCases.includes(s.id))) await check(`agent/${scenario.id}`, async () => {
      const id = `agent-${scenario.id}`; create(id, scenario.doc);
      const before = structuredClone(getProject(id)!.edit);
      const result = startAgentTurn(id, scenario.note);
      assert(result.ok, result.ok ? "" : result.error);
      const started = Date.now(); let previous = "";
      while (isAgentBusy(id)) {
        if (Date.now() - started > 240_000) { cancelAgentTurn(id); throw new Error("La prueba del agente superó 4 minutos"); }
        const step = liveAgentStep(id);
        if (step && step !== previous) { console.log(`  ${scenario.id}: ${step}`); previous = step; }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const messages = listAgentMessages(id, 20);
      await fs.writeFile(path.join(root, `${id}.json`), JSON.stringify(messages, null, 2));
      const after = getProject(id)!.edit;
      untouched(before, after, scenario, true); scenario.check(before, after);
      assert(after.revision > before.revision, "el agente no aplicó la nota");
      const review = readNoteReview(id);
      assert(review, "el agente no utilizó el flujo protegido de notas");
      assert.equal(pendingNotePages(review).length, 0, "el agente dejó lotes sin revisar");
      assert.equal(review.unavailable.size, 0, "faltaron imágenes de revisión");
      return { elapsedSeconds: Math.round((Date.now() - started) / 1000), actions: messages.flatMap((m) => m.actions).map((a) => ({ tool: a.tool, ok: a.ok })) };
    });
  }
  await check("safety/original-media-unchanged", async () => {
    const current = await Promise.all(paths.map(async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")));
    assert.deepEqual(current, hashes, "se modificaron medios originales durante las pruebas del agente");
  });
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify({ root, results: report }, null, 2));
  console.log(`REPORT ${path.join(root, "report.json")}`);
  console.log(`${report.filter((r) => r.status === "PASS").length}/${report.length} comprobaciones correctas`);
  getDb().$client.close();
  if (report.some((r) => r.status !== "PASS")) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
