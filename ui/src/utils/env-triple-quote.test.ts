import { describe, expect, it } from "vitest";
import {
  computeTripleQuoteContinuationLines,
  lineOpensUnclosedTripleQuote,
  splitEnvLines,
} from "./env-triple-quote";

describe("lineOpensUnclosedTripleQuote", () => {
  it("detects an opener without a same-line closer", () => {
    expect(lineOpensUnclosedTripleQuote('DEPLOY_SSH_KEY="""')).toBe(true);
  });

  it("ignores a single-line triple-quoted value", () => {
    expect(lineOpensUnclosedTripleQuote('A="""x"""')).toBe(false);
  });
});

describe("computeTripleQuoteContinuationLines", () => {
  it("marks PEM and base64 lines, not the opening key line", () => {
    const lines = splitEnvLines(
      'DEPLOY_SSH_KEY="""\n-----BEGIN OPENSSH PRIVATE KEY-----\nYWxj=\n-----END OPENSSH PRIVATE KEY-----\n"""\nPLAIN=ok\n',
    );
    const cont = computeTripleQuoteContinuationLines(lines);
    expect(cont.has(0)).toBe(false);
    expect(cont.has(1)).toBe(true);
    expect(cont.has(2)).toBe(true);
    expect(cont.has(3)).toBe(true);
    expect(cont.has(4)).toBe(true);
    expect(cont.has(5)).toBe(false);
  });
});
