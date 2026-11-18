import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

/**
 * HyperFrames' own skills travel with the app: the agent gets the repository's copy of them
 * (src/lib/agent/cli/workspace.ts picks the same ones from the same lock file).
 */
function hyperframesSkills(): string[] {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), "skills-lock.json"), "utf8")) as { skills?: Record<string, { source?: string }> };
    const names = Object.entries(lock.skills ?? {}).filter(([, skill]) => skill.source === "heygen-com/hyperframes").map(([name]) => name);
    return names.length ? ["./skills-lock.json", ...names.map((name) => `./.agents/skills/${name}/**/*`)] : [];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      { source: "/ajustes", destination: "/settings", permanent: true },
      { source: "/biblioteca", destination: "/library", permanent: true },
      { source: "/estilo", destination: "/style", permanent: true },
      { source: "/projects/:id/resultado", destination: "/projects/:id/results", permanent: true },
    ];
  },
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**/*", "./agent-skills/**/*", ...hyperframesSkills(), "./src/templates/**/scene.html", "./public/fonts/*", "./node_modules/gsap/dist/gsap.min.js"],
  },
  outputFileTracingExcludes: { "/*": ["./storage/**/*", "./.env*"] },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
