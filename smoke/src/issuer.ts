import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";

/**
 * The test account's own identity provider: the mock publishes its public key
 * as a JWKS, the signed-in application trusts that JWKS, and the tests sign
 * end-user tokens with the private half. That exercises the whole signed-in
 * path — signature, issuer, audience, required claims, token exchange — with
 * no third-party identity provider in the loop.
 */
export const ISSUER = "https://smoke.app-ai-gateway.invalid";
export const AUDIENCE = "app-ai-gateway-smoke";
/** The claim the signed-in application requires, standing in for a paid entitlement. */
export const REQUIRED_CLAIM = { path: "plan", equals: "pro" } as const;

const ALGORITHM = "RS256";

export async function generateIssuerKey(): Promise<string> {
  const { privateKey } = await generateKeyPair(ALGORITHM, { extractable: true });
  const jwk = await exportJWK(privateKey);
  return JSON.stringify({ ...jwk, alg: ALGORITHM, kid: `smoke-${Date.now().toString(36)}`, use: "sig" });
}

function parse(privateJwk: string): JWK & { kid: string } {
  const jwk = JSON.parse(privateJwk) as JWK;
  if (typeof jwk.kid !== "string" || typeof jwk.d !== "string") {
    throw new Error("SMOKE_ISSUER_KEY must be a private JWK with a kid; generate one with `keygen`");
  }
  return jwk as JWK & { kid: string };
}

/** The JWKS the mock serves: the public half only. */
export function publicJwks(privateJwk: string): { keys: JWK[] } {
  const { kty, n, e, kid, alg } = parse(privateJwk);
  return { keys: [{ kty, n, e, kid, alg, use: "sig" }] };
}

/** An end-user token, with the required claim unless `claims` replaces it. */
export async function endUserToken(
  privateJwk: string,
  subject: string,
  claims: Record<string, unknown> = { [REQUIRED_CLAIM.path]: REQUIRED_CLAIM.equals },
): Promise<string> {
  const jwk = parse(privateJwk);
  const key = await importJWK(jwk, ALGORITHM);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM, kid: jwk.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}
