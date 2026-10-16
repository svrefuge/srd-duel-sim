/** `--name value`. A flag written without its value (nothing, or another flag, follows it) is an error, not a NaN. */
export function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const value = process.argv[idx + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function flag(name: string): boolean {
  return process.argv.includes(name);
}
