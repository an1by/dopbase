import fs from "node:fs";
import path from "node:path";

const dir = import.meta.dir;
for (const [name, dest] of [
  ["env-triple-quote.ts.full", "../src/utils/env-triple-quote.ts"],
  ["env-highlight.ts.full", "../src/utils/env-highlight.ts"],
]) {
  fs.copyFileSync(path.join(dir, name), path.join(dir, dest));
}
console.log("ok");
