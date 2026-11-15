import fs from "node:fs";
import path from "node:path";

const target = path.join(import.meta.dir, "../src/utils/env-file.ts");

const source = path.join(import.meta.dir, "env-file.ts.full");
fs.copyFileSync(source, target);
console.log("copied", fs.readFileSync(target, "utf8").split("\n").length, "lines");
