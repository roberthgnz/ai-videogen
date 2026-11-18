import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { files: ["desktop/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Installed agent skills and local data are not app code.
    ".agents/**",
    ".claude/**",
    "storage/**",
    ".desktop/**",
    "src-tauri/target/**",
    "src-tauri/resources/**",
    "src-tauri/gen/**",
  ]),
]);

export default eslintConfig;
