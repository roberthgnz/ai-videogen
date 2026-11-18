/**
 * Runs the b-roll step for a project: searches, picks one asset per shot and downloads them.
 *   npm run visuals -- <projectId> [vertical|horizontal] [--refresh]
 * --refresh searches again for every shot not picked by hand.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const [projectId, formatArg] = args.filter((a) => !a.startsWith("--"));
  if (!projectId) {
    console.error("Uso: npm run visuals -- <projectId> [vertical|horizontal]");
    process.exit(1);
  }
  const { runVisualsForProject } = await import("../src/lib/pipeline/steps/visuals");
  const { getProject } = await import("../src/lib/projects");
  const format = formatArg === "horizontal" || formatArg === "vertical" ? formatArg : undefined;
  const started = Date.now();
  const result = await runVisualsForProject(projectId, { format, download: true, refresh });
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.skipped) {
    console.error("Sin proveedor de b-roll: falta PIXABAY_API_KEY en .env.local.");
    process.exit(1);
  }
  for (const [i, scene] of getProject(projectId)!.scenes.entries()) {
    console.log(`Escena ${i + 1}: ${scene.visualQueries.join(" | ")}`);
    for (const shot of scene.shots ?? []) {
      const c = shot.selected;
      console.log(`  ${shot.query.padEnd(34)} ${c ? `${c.kind} ${c.id} ${c.width}x${c.height} ${c.durationSec ?? "-"}s rel ${c.relevance ?? "?"}` : "sin resultado"}`);
    }
  }
  console.error(`${result.shots} planos en ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
