import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Whether the module at `url` is the script Node was started with. */
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url);
}

/** The value after `--name`, if given. */
export function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Sets `entries` in a dotenv file, replacing lines for the same names and
 * keeping every other line. Generated secrets go to a file, owner-only, and are
 * never printed.
 */
export function writeEnvFile(path: string, entries: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const kept = lines.filter((line) => {
    const name = /^\s*([A-Z0-9_]+)\s*=/u.exec(line)?.[1];
    return name === undefined || !(name in entries);
  });
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  for (const [name, value] of Object.entries(entries)) kept.push(`${name}=${quote(value)}`);
  writeFileSync(path, `${kept.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Single-quoted, which dotenv readers (Node's included) take literally, JSON and all. */
function quote(value: string): string {
  if (value.includes("'") || value.includes("\n")) throw new Error("Refusing to write a value dotenv cannot quote");
  return `'${value}'`;
}

export function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
