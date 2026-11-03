import { randomBytes } from "node:crypto";
import { fail, isMain, option, writeEnvFile } from "./cli.ts";
import { smokeEnv } from "./env.ts";
import { gatewayError, GatewayFailure } from "./gateway.ts";

/**
 * Creates the dedicated test account on a gateway that allows email sign-up —
 * a local one, or your own deployment — and a management key for it:
 *
 *   SMOKE_GATEWAY_URL=… node src/account.ts --email smoke@example.com --write-env /private/path/smoke.env
 *
 * The password is taken from SMOKE_ACCOUNT_PASSWORD when set, and otherwise
 * generated; either way it and the new key are written to the env file, never
 * printed. Run again with the same file to sign in instead and mint a new key.
 *
 * On a deployment where sign-up needs a verified email, create the account in
 * the console instead and create the management key on its Access page.
 */
async function account(email: string, envFile: string): Promise<void> {
  const env = smokeEnv();
  const saved = process.env.SMOKE_ACCOUNT_PASSWORD?.trim();
  const password = saved || randomBytes(18).toString("base64url");
  const headers = { "content-type": "application/json", origin: env.consoleUrl };

  let session = await fetch(`${env.consoleUrl}/v1/auth/sign-up/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password, name: "Smoke tests" }),
  });
  if (!session.ok) {
    const signUp = await gatewayError(session);
    if (!saved) {
      throw new GatewayFailure("Sign-up", session.status, signUp.code, signUp.message);
    }
    session = await fetch(`${env.consoleUrl}/v1/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password }),
    });
    if (!session.ok) {
      const signIn = await gatewayError(session);
      throw new GatewayFailure("Sign-in", session.status, signIn.code, signIn.message);
    }
  }
  // Saved before anything else can fail, so a retry signs in rather than
  // finding the address taken by an account nobody knows the password of.
  writeEnvFile(envFile, { SMOKE_ACCOUNT_PASSWORD: password });
  const cookie = session.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");

  const created = await fetch(`${env.consoleUrl}/v1/admin/keys`, {
    method: "POST",
    headers: { ...headers, cookie, "x-console-request": "1" },
    body: JSON.stringify({ name: `smoke ${env.runner}`, grant: "manage" }),
  });
  if (!created.ok) {
    const { code, message } = await gatewayError(created);
    throw new GatewayFailure("Creating the management key", created.status, code, message);
  }
  const { key } = (await created.json()) as { key: { plaintext: string } };
  writeEnvFile(envFile, { SMOKE_MANAGEMENT_KEY: key.plaintext });
}

if (isMain(import.meta.url)) {
  const email = option("email");
  const envFile = option("write-env");
  if (!email || !envFile) fail("Usage: account --email <address> --write-env <path>");
  account(email, envFile).then(
    () => console.log(`Test account ready; wrote SMOKE_ACCOUNT_PASSWORD and SMOKE_MANAGEMENT_KEY to ${envFile}`),
    fail,
  );
}
