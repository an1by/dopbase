/** Shared `KEY="""` … `"""` block detection (parser + editor highlight). */

export const TRIPLE_DOUBLE = '"""';

export function lineOpensUnclosedTripleQuote(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return false;
  }
  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice(7).trim()
    : trimmed;
  const separator = withoutExport.indexOf("=");
  if (separator <= 0) {
    return false;
  }
  const rawValue = withoutExport.slice(separator + 1).trim();
  if (!rawValue.startsWith(TRIPLE_DOUBLE)) {
    return false;
  }
  const body = rawValue.slice(TRIPLE_DOUBLE.length);
  return !body.endsWith(TRIPLE_DOUBLE);
}

/**
 * 0-based line indices that are inside a multiline triple-quoted value
 * (not the opening `KEY="""` line).
 */
export function computeTripleQuoteContinuationLines(lines: string[]): Set<number> {
  const continuation = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) {
      i += 1;
      continue;
    }
    const rawValue = withoutExport.slice(separator + 1).trim();
    if (!rawValue.startsWith(TRIPLE_DOUBLE)) {
      i += 1;
      continue;
    }
    const body = rawValue.slice(TRIPLE_DOUBLE.length);
    if (body.endsWith(TRIPLE_DOUBLE)) {
      i += 1;
      continue;
    }
    i += 1;
    while (i < lines.length) {
      continuation.add(i);
      if (lines[i].trimEnd().endsWith(TRIPLE_DOUBLE)) {
        i += 1;
        break;
      }
      i += 1;
    }
  }
  return continuation;
}

export function splitEnvLines(content: string): string[] {
  return content.split(/\r?\n/);
}
