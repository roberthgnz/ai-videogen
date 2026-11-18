/**
 * Builds a project's HyperFrames composition without rendering it.
 *   npm run compose -- <projectId> [vertical|horizontal] [pop|line|box]
 * Output: storage/projects/<id>/preview-<format>/ (then `npx hyperframes check|snapshot|preview <dir>`).
 */
import path from "node:path";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const [projectId, formatArg, styleArg] = process.argv.slice(2);
  if (!projectId) {
    console.error("Uso: npm run compose -- <projectId> [vertical|horizontal]");
    process.exit(1);
  }
  const { composeProject } = await import("../src/lib/pipeline/steps/compose");
  const { getProject } = await import("../src/lib/projects");
  const { storagePaths } = await import("../src/lib/storage");
  const format = formatArg === "horizontal" || formatArg === "vertical" ? formatArg : getProject(projectId)?.format ?? "vertical";
  const dir = path.join(storagePaths.project(projectId), `preview-${format}`);
  const captionStyle = styleArg === "pop" || styleArg === "line" || styleArg === "box" ? styleArg : undefined;
  const plan = composeProject(projectId, dir, { format, captionStyle });
  console.log(dir);
  console.error(
    `${plan.width}x${plan.height} · ${plan.durationSec}s · ${plan.scenes.map((s) => `${s.id}@${s.start}+${s.duration}`).join(" ")}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
