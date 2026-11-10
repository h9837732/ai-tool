/* 把前端文件同步到 www/，给 Capacitor 打包用。
   根目录那套文件是网页版的源头，直接改、直接 http:// 打开就行；
   要出 APK 时跑一次 bun run build 同步过去。 */

import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = import.meta.dir;
const OUT = join(ROOT, "www");

const FILES = ["index.html", "sw.js", "manifest.webmanifest", "icon.svg"];
const DIRS = ["css", "js"];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const f of FILES) {
  await cp(join(ROOT, f), join(OUT, f));
  console.log("  copy", f);
}
for (const d of DIRS) {
  await cp(join(ROOT, d), join(OUT, d), { recursive: true });
  const items = await readdir(join(ROOT, d));
  console.log("  copy", d + "/", "(" + items.length + " files)");
}

console.log("\nwww/ 已更新，可以跑 npx cap sync android");
