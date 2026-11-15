import fs from "node:fs";
import path from "node:path";

const target = path.join(import.meta.dir, "../src/pages/Projects/components/EnvFileEditor.vue");
let s = fs.readFileSync(path.join(import.meta.dir, "EnvFileEditor.vue.clean"), "utf8");

s = s.replace(
  `import type { EnvFileIssue } from "~/utils/env-file";`,
  `import { parseEnvFileLines, type EnvFileIssue } from "~/utils/env-file";`,
);

s = s.replace(
  `/** Lines that declare a key — the status bar's key count. */
const keyCount = computed(
  () =>
    lineTokens.value.filter((tokens) =>
      tokens.some((token) => token.type === "key"),
    ).length,
);`,
  `/** Parsed key count (ignores PEM/base64 lines inside triple-quoted blocks). */
const keyCount = computed(
  () => parseEnvFileLines(props.modelValue).entries.length,
);`,
);

fs.writeFileSync(target, s);
console.log("ok", s.split("\n").length);
