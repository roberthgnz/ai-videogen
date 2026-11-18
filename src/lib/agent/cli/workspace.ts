import { t as translate, languageName } from "@/lib/i18n";
import fs from "node:fs";
import path from "node:path";
import type { CliProviderId } from "@/lib/app-settings-shared";
import { getProject } from "@/lib/projects";
import { appResource, hyperframesCommand, runtimeBinary } from "@/lib/runtime";
import { storagePaths } from "@/lib/storage";
import { findExecutable } from "./process";

/**
 * The project folder is the installed program's workspace, as a repository is for a coding agent: it finds
 * the studio's instructions (AGENTS.md for Codex, CLAUDE.md for Claude Code), the studio's skills, the
 * user's files to inspect, and a folder of its own. Its conversation is kept per project, so the chat
 * continues like a session in the terminal.
 */

/** The studio's skills, editable Markdown in the repository (`agent-skills/<name>/SKILL.md`). */
function skillsSource(): string {
  return appResource("agent-skills");
}

/** Where each program looks for a project's skills. */
const SKILL_DIR: Record<CliProviderId, string> = { "claude-code": path.join(".claude", "skills"), codex: path.join(".agents", "skills") };
const SKILL_DIRS = Object.values(SKILL_DIR);

/**
 * HyperFrames' own skills: how to write a composition, its command line, its catalogue of ready-made blocks,
 * and the blocks installed as skills. They are the repository's copy (`.agents/skills`, put there by the
 * skills installer and pinned in skills-lock.json) and reach the agent as they are, so updating them there
 * updates what the agent knows. `agent-skills/hyperframes-compositions` says how they apply in the studio.
 */
const HYPERFRAMES_SOURCE = "heygen-com/hyperframes";
/** Left inside each copied skill: the version it was copied from, so an unchanged skill is not copied again. */
const SKILL_VERSION_FILE = ".videogen-version";

interface SkillFolder {
  name: string;
  dir: string;
}

function hyperframesSkills(): (SkillFolder & { version: string })[] {
  try {
    const lock = JSON.parse(fs.readFileSync(appResource("skills-lock.json"), "utf8")) as { skills?: Record<string, { source?: string; computedHash?: string }> };
    return Object.entries(lock.skills ?? {})
      .filter(([name, skill]) => skill.source === HYPERFRAMES_SOURCE && /^[a-z0-9][a-z0-9-]{0,79}$/.test(name))
      .map(([name, skill]) => ({ name, dir: appResource(".agents", "skills", name), version: skill.computedHash ?? "" }))
      .filter((skill) => fs.existsSync(path.join(/*turbopackIgnore: true*/ skill.dir, "SKILL.md")))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // Not installed on this computer: the agent works with the studio's skills alone.
    return [];
  }
}

/** The agent's own folder inside the project: scratch files and the saved session. */
export const AGENT_DIR = "agent";

function resolveBinary(key: "FFMPEG_PATH" | "FFPROBE_PATH", name: string): string {
  try {
    const value = runtimeBinary(key, name);
    return path.isAbsolute(value) ? value : findExecutable(value) ?? value;
  } catch {
    return name;
  }
}

/** The studio's skills, by name. */
function studioSkills(): SkillFolder[] {
  const source = skillsSource();
  try {
    return fs.readdirSync(source, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: d.name, dir: path.join(/*turbopackIgnore: true*/ source, d.name) })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Copies the skills into the project; skills the user added stay. The studio's are small and are refreshed
 * every turn. HyperFrames' are megabytes: they go only where this program looks, and again only when their
 * version changes.
 */
function syncSkills(dir: string, provider?: CliProviderId) {
  const studio = studioSkills();
  for (const base of SKILL_DIRS) {
    for (const skill of studio) {
      const target = path.join(/*turbopackIgnore: true*/ dir, base, skill.name);
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(skill.dir, target, { recursive: true, force: true });
    }
  }
  for (const skill of hyperframesSkills()) {
    // A studio skill of the same name wins.
    if (studio.some((s) => s.name === skill.name)) continue;
    for (const base of provider ? [SKILL_DIR[provider]] : SKILL_DIRS) {
      const target = path.join(/*turbopackIgnore: true*/ dir, base, skill.name);
      const versionFile = path.join(/*turbopackIgnore: true*/ target, SKILL_VERSION_FILE);
      try {
        if (skill.version && fs.readFileSync(versionFile, "utf8") === skill.version) continue;
      } catch { /* not copied yet */ }
      try {
        fs.mkdirSync(target, { recursive: true });
        fs.cpSync(skill.dir, target, { recursive: true, force: true, dereference: true });
        fs.writeFileSync(versionFile, skill.version);
      } catch (error) {
        // The turn goes on with the studio's skills; the next one tries again.
        console.warn(translate("[agent-cli] could not copy the skill {0}:", skill.name), error instanceof Error ? error.message : error);
      }
    }
  }
}

/** Skills as a list for the instructions: name and its description from the SKILL.md front matter. */
function skillCatalog(skills: SkillFolder[]): string {
  return skills.map(({ name, dir }) => {
    let description = "";
    try {
      const text = fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, "SKILL.md"), "utf8");
      description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
    } catch { /* a folder without SKILL.md: listed by name only */ }
    // The first sentence is enough to choose; the program reads the whole skill when it uses it.
    return `- \`${name}\`${description ? `: ${description.split(/(?<=\.)\s/)[0]}` : ""}`;
  }).join("\n");
}

/** HyperFrames in the instructions: its skills and the command that runs the studio's copy. Empty where it is not installed. */
function hyperframesSection(): { skills: string; tool: string } {
  const skills = hyperframesSkills();
  if (!skills.length) return { skills: "", tool: "" };
  let tool = "";
  try {
    const { node, cli } = hyperframesCommand();
    tool = translate("- Use the studio's painted HyperFrames: `\"{0}\" \"{1}\"`. Pass the same arguments as `npx hyperframes <command>` in a skill. In PowerShell, prefix the quoted executable with `&`. Avoid `npx`, which may download another version.\n", node, cli);
  } catch { /* without its command the skills are still worth reading */ }
  return {
    tool,
    skills: `- HyperFrames skills cover composition authoring, the CLI, and the catalog of ready-made blocks.
  Load \`hyperframes-compositions\` first for the studio's authoring and import workflow.

${skillCatalog(skills)}

`,
  };
}

function instructions(projectId: string, dir: string): string {
  const p = getProject(projectId);
  const assets = p?.edit.assets ?? [];
  const rel = (stored: string) => {
    const absolute = path.join(/*turbopackIgnore: true*/ path.dirname(path.dirname(dir)), stored);
    return path.relative(dir, absolute).split(path.sep).join("/");
  };
  const rows = assets.map((a) => `| ${a.id} | ${a.name.replace(/\|/g, "/")} | ${a.kind} | ${a.duration ? `${a.duration.toFixed(1)} s` : "-"} | ${rel(a.path)} |`);
  const hyperframes = hyperframesSection();
  return `# VideoGen project: “${p?.title || "Untitled"}”

You are in a VideoGen project folder. The user works with you through the studio chat and sees your replies, progress, and action buttons.

**Reply in ${languageName()}** regardless of the language used by the tools. For new video text and narration, follow any language explicitly requested by the user.

## Project files

- \`media/\` is read-only. It contains imported files (listed below) and graphics created with
  \`create_graphic\`. A graphic's \`source.json\` stores its HTML, CSS, and animation.
- \`footage/\`, \`overview/\`, \`analysis/\`, and \`thumbnails/\` are read-only studio analysis.
- \`${AGENT_DIR}/\` is for auxiliary files such as extracted frames and notes. Author HyperFrames compositions in \`${AGENT_DIR}/compositions/<name>/\`.
- Load relevant studio skills from \`.claude/skills\` or \`.agents/skills\` for editing guidance beyond the tool descriptions.

${skillCatalog(studioSkills()) || "- (No studio skills on this device)"}

${hyperframes.skills}## Edit the video

Use the studio tools on the \`videogen\` MCP server for changes to scripts, edits, text, style, voice, and renders. The studio cannot see direct edits to project files or the database. Use the CURRENT STATE received with each message as the source of truth.

## Files

| ID | Name | Type | Duration | Path |
| --- | --- | --- | --- | --- |
${rows.join("\n") || "| - | (No files yet) | - | - | - |"}

## Local tools

- ffmpeg: \`${resolveBinary("FFMPEG_PATH", "ffmpeg")}\`
- ffprobe: \`${resolveBinary("FFPROBE_PATH", "ffprobe")}\`
${hyperframes.tool}`;
}

/** Writes the instructions and skills into the project folder and returns its absolute path. */
export function prepareWorkspace(projectId: string, provider?: CliProviderId): string {
  // Runtime data, not app code: keep it out of the build's file tracing.
  const dir = path.resolve(/*turbopackIgnore: true*/ storagePaths.project(projectId));
  fs.mkdirSync(path.join(/*turbopackIgnore: true*/ dir, AGENT_DIR, "tmp"), { recursive: true });
  const text = instructions(projectId, dir);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) fs.writeFileSync(path.join(/*turbopackIgnore: true*/ dir, name), text);
  syncSkills(dir, provider);
  return dir;
}

export interface AgentSession {
  provider: CliProviderId;
  /** Claude Code's session id or Codex's thread id. */
  id: string;
  /** The files the program has seen contact sheets of, so a resumed turn only sends new ones. */
  seenAssets: string[];
}

const sessionFile = (projectId: string) => path.join(/*turbopackIgnore: true*/ storagePaths.project(projectId), AGENT_DIR, "sesion.json");

/** The conversation to continue with this program, or null to start a new one. */
export function readSession(projectId: string, provider: CliProviderId): AgentSession | null {
  try {
    const saved = JSON.parse(fs.readFileSync(sessionFile(projectId), "utf8")) as AgentSession;
    return saved.provider === provider && typeof saved.id === "string" && saved.id ? { ...saved, seenAssets: saved.seenAssets ?? [] } : null;
  } catch {
    return null;
  }
}

export function saveSession(projectId: string, session: AgentSession): void {
  const file = sessionFile(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
}

/** «Borrar conversación» or a new engine: the next turn starts a fresh session. */
export function resetSession(projectId: string): void {
  fs.rmSync(sessionFile(projectId), { force: true });
}
