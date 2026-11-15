// Turns a CLI argv into its command words, without global options, so
// `--json secret get app/dev KEY --reveal` becomes `secret get app/dev KEY`.
// Shared by the CLI helper and the coverage check.

// Options that take a value and can come before the command.
const GLOBAL_WITH_VALUE = new Set(["--server", "--data-dir"]);

export function commandWords(args: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (GLOBAL_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    words.push(arg);
  }
  return words;
}
