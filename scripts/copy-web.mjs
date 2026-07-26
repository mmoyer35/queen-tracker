// Stages the static web app into www/ so Capacitor can bundle it into the
// native iOS/Android apps. GitHub Pages keeps serving the files at the repo
// root; this just makes a clean copy for the native builds.
import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT = "www";
const INCLUDE = ["index.html", "privacy.html", "js", "assets", "icons", "manifest.webmanifest", "sw.js"];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
let copied = [];
for (const item of INCLUDE) {
  if (existsSync(item)) { await cp(item, `${OUT}/${item}`, { recursive: true }); copied.push(item); }
}
console.log("Staged into www/:", copied.join(", ") || "(nothing found)");
