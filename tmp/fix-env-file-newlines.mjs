import fs from "node:fs";

const path = new URL("../src/utils/env-file.ts", import.meta.url);
let s = fs.readFileSync(path, "utf8");

const brokenIf = `        if (buf !== "") {
          buf += "
";
        }`;

const fixedIf = `        if (buf !== "") {
          buf += "\\n";
        }`;

const brokenElse = `    if (buf !== "") {
      buf += "
";
    }`;

const fixedElse = `    if (buf !== "") {
      buf += "\\n";
    }`;

if (!s.includes(brokenIf)) {
  console.error("brokenIf pattern not found");
  process.exit(1);
}

s = s.replaceAll(brokenIf, fixedIf);
s = s.replaceAll(brokenElse, fixedElse);
fs.writeFileSync(path, s);
console.log("ok");
