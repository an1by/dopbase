import fs from "node:fs";
import path from "node:path";

const target = path.join(import.meta.dir, "../src/utils/env-highlight.ts");
const source = path.join(import.meta.dir, "env-highlight.ts.full");
fs.copyFileSync(source, target);
console.log("ok");
