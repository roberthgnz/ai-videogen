/**
 * Composes and renders a project to MP4 through the same step the app uses.
 *   npm run render -- <projectId> [vertical|horizontal] [draft|looks|delivery]
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const [projectId, formatArg, qualityArg] = process.argv.slice(2);
  if (!projectId) {
    console.error("Usage: npm run render -- <projectId> [vertical|horizontal] [draft|looks|delivery]");
    process.exit(1);
  }
  const { startVideo, isRenderActive } = await import("../src/lib/pipeline/steps/video");
  const { getVideo } = await import("../src/lib/projects");
  const { resolveInStorage } = await import("../src/lib/storage");

  const format = formatArg === "horizontal" || formatArg === "vertical" ? formatArg : undefined;
  const quality = qualityArg === "draft" || qualityArg === "delivery" || qualityArg === "looks" ? qualityArg : "looks";
  const started = Date.now();
  const result = startVideo(projectId, { format, quality });
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  let last = "";
  while (isRenderActive(result.videoId)) {
    await new Promise((r) => setTimeout(r, 500));
    const v = getVideo(result.videoId)!;
    const line = `${v.status} ${v.stage ?? ""} ${Math.round(v.progress)}%`;
    if (line !== last) console.error(line);
    last = line;
  }
  const v = getVideo(result.videoId)!;
  console.error(`${v.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (v.status !== "done") {
    console.error(v.error);
    process.exit(1);
  }
  console.log(resolveInStorage(v.outputPath!));
  console.error(`Duration ${v.durationSec}s (expected ${v.expectedDurationSec}s)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
