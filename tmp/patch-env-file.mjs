import fs from "node:fs";
import path from "node:path";

const file = path.join(import.meta.dir, "../src/utils/env-file.ts");
let s = fs.readFileSync(file, "utf8");

if (!s.includes('from "./env-triple-quote"')) {
  s = s.replace(
    "// Keep the browser grammar identical to the secrets endpoint.\nconst KEY_PATTERN",
    `import {
  TRIPLE_DOUBLE,
  computeTripleQuoteContinuationLines,
  splitEnvLines,
} from "./env-triple-quote";

// Keep the browser grammar identical to the secrets endpoint.
const KEY_PATTERN`,
  );
  s = s.replace(
    "const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;\nconst TRIPLE_DOUBLE = '\"\"\"';\n\n",
    "const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;\n\n",
  );
}

s = s.replace(
  "const lines = content.split(/\\r?\\n/);",
  "const lines = splitEnvLines(content);",
);

if (!s.includes("filterIssuesOutsideTripleQuoteBodies")) {
  s = s.replace(
    "  return { entries, issues };\n}",
    `  const continuation = computeTripleQuoteContinuationLines(lines);
  const filteredIssues = issues.filter(
    (issue) => !continuation.has(issue.line - 1),
  );

  return { entries, issues: filteredIssues };
}`,
  );
}

fs.writeFileSync(file, s);
console.log("patched env-file.ts");
