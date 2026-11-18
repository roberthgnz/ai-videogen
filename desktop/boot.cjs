// The parent assigns this process to its lifecycle group before releasing stdin.
// Do not start Next (or any descendants) until that handshake completes.
const readline = require("node:readline");
const path = require("node:path");
const lines = readline.createInterface({ input: process.stdin });
lines.once("line", (line) => {
  if (line !== "start") process.exit(1);
  lines.close();
  const root = process.env.VIDEOGEN_APP_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error("Missing application resources");
  require("./migrate.cjs");
  require(path.join(root, "server.js"));
});
process.stdin.on("end", () => process.exit(0));
