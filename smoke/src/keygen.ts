import { randomBytes } from "node:crypto";
import { fail, isMain, option, writeEnvFile } from "./cli.ts";
import { generateIssuerKey } from "./issuer.ts";

/**
 * Generates the two secrets the mock and the tests share — the fake provider
 * key and the test issuer's signing key — into a dotenv file:
 *
 *   node src/keygen.ts --write-env /private/path/smoke.env
 *
 * Existing values in the file are replaced; nothing is printed.
 */
export async function keygen(envFile: string): Promise<void> {
  writeEnvFile(envFile, {
    SMOKE_MOCK_SECRET: `smoke_${randomBytes(24).toString("base64url")}`,
    SMOKE_ISSUER_KEY: await generateIssuerKey(),
  });
}

if (isMain(import.meta.url)) {
  const envFile = option("write-env");
  if (!envFile) fail("Usage: keygen --write-env <path>");
  keygen(envFile).then(() => console.log(`Wrote SMOKE_MOCK_SECRET and SMOKE_ISSUER_KEY to ${envFile}`), fail);
}
