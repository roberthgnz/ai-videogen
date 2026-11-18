# Contributing to VideoGen

Follow the [quickstart](README.md#getting-started) to run the editor locally.

## Propose a change

Use [GitHub Issues](https://github.com/roberthgnz/ai-videogen/issues) to describe a problem or suggest improvements. For a bug report, include your OS, Node.js version, whether you used the web or desktop app, and the steps and error. Share sample media and logs with private data removed.

In a pull request, describe what changes for the user and link the issue if there is one.

## Find your way around the code

| Directory | What it contains |
| --- | --- |
| `src/app/` | Next.js pages, studio and API routes |
| `src/lib/editing/` | Timeline, media import, subtitles and exports |
| `src/lib/pipeline/` | Script, voice, stock footage, composition and rendering |
| `src/templates/` | Scene templates and compositions |
| `src/lib/agent/` and `agent-skills/` | Studio assistant tools and instructions |
| `src/lib/i18n/` | Language selection and the Spanish message catalog |
| `drizzle/` | SQLite migrations |
| `src-tauri/` and `scripts/desktop/` | Native launcher and Windows installer preparation |

Read [AGENTS.md](AGENTS.md) before changing Next.js or UI SDK code. If you change the SQLite schema, include the migration from `npm run db:generate`. The [script reference](README.md#scripts) lists the other development commands.

## Add a message

Use an English message in `t()` from `@/lib/i18n` and add its Spanish translation to `src/lib/i18n/es.json`. Numbered placeholders such as `{0}` let translators move values to the right place in the sentence. Keep IDs, route paths, and values saved to projects independent of the display language.

The startup and credentials windows use a separate catalog in `src-tauri/ui/localization.js` because they run before or independently of the web server.
