/* 把前端文件同步到 www/，给 Capacitor 打包用。
   根目录那套文件是网页版的源头，直接改、直接 http:// 打开就行；
   要出 APK 时跑一次 bun run sync 同步过去。
   另外把 package.json 的版本号写成 js/version.js，全项目只有一处版本来源。 */

import { cp, mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = import.meta.dir;
const OUT = join(ROOT, "www");

const FILES = ["index.html", "sw.js", "manifest.webmanifest", "icon.svg"];
const DIRS = ["css", "js"];

/* 1. 生成 version.js（www 和根目录都写一份，网页版也要用） */
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const versionJs = `/* 由 build.mjs 从 package.json 生成，不要手改 */\nwindow.APP_VERSION = '${pkg.version}';\n`;
await writeFile(join(ROOT, "js/version.js"), versionJs, "utf8");
console.log("  version", pkg.version);

/* 2. 同步静态资源 */
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
