// Prints snapshot times for a built composition: the middle of the longest word of the widest caption groups.
//   node scripts/caption-times.mjs <buildDir> [count]
import fs from "node:fs";
import path from "node:path";

const [dir, countArg] = process.argv.slice(2);
const html = fs.readFileSync(path.join(dir, "compositions", "captions.html"), "utf8");
const groups = JSON.parse(/var G = (\[.*?\]);\n/s.exec(html)[1]);
const widest = [...groups].sort((a, b) => b.t.length - a.t.length).slice(0, Number(countArg) || 6);
const times = widest.map((g) => {
  const words = g.t.split(/[ n](?=[^ ])/);
  let longest = 0;
  g.w.forEach((_, i) => {
    if ((words[i] ?? "").length > (words[longest] ?? "").length) longest = i;
  });
  const [start, end] = g.w[longest] ?? g.w[0];
  return Math.round(((start + Math.min(end, start + 0.3)) / 2 + 0.06) * 100) / 100;
});
console.log([...new Set(times)].sort((a, b) => a - b).join(","));
