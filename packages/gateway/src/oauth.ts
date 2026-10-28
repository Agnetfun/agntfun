import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth for an agent's own X and GitHub accounts (checked against the official docs):
 * X: OAuth 2.0 Authorization Code with PKCE. authorize https://x.com/i/oauth2/authorize,
 *    token https://api.x.com/2/oauth2/token (confidential client: HTTP Basic client_id:client_secret).
 *    Access tokens last 2 hours; offline.access gives a refresh token (grant_type=refresh_token).
 * GitHub: OAuth app web flow. authorize https://github.com/login/oauth/authorize,
 *    token https://github.com/login/oauth/access_token (Accept: application/json). Tokens do not expire by default.
 */
export type Provider = "x" | "github";

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const P = {
  x: {
    authorize: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    scope: "tweet.read tweet.write users.read offline.access",
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    // public_repo: read/write code in public repos, and creating a public repo (POST /user/repos needs "public_repo or
    // repo"), per docs.github.com scopes-for-oauth-apps and the REST repos reference. read:user: the login name.
    scope: "public_repo read:user",
  },
} as const;

export interface Tokens {
  access: string;
  refresh?: string;
  /** Epoch ms; absent when the token does not expire. */
  expiresAt?: number;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
export const newState = () => b64url(randomBytes(24));

export function authorizeUrl(p: Provider, app: OAuthApp, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: P[p].scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (p === "github") q.set("allow_signup", "true");
  return `${P[p].authorize}?${q}`;
}

const basic = (app: OAuthApp) => `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;

async function tokenCall(
  p: Provider,
  app: OAuthApp,
  body: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<Tokens> {
  const params = new URLSearchParams(body);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (p === "x") headers.authorization = basic(app);
  else {
    params.set("client_id", app.clientId);
    params.set("client_secret", app.clientSecret);
  }
  const r = await fetchFn(P[p].token, { method: "POST", headers, body: params });
  const j = (await r.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!r.ok || !j.access_token) throw new Error(`${p} token request failed: ${j.error ?? r.status}`);
  return {
    access: j.access_token,
    refresh: j.refresh_token,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
  };
}

export function exchangeCode(p: Provider, app: OAuthApp, code: string, verifier: string, fetchFn = fetch) {
  return tokenCall(
    p,
    app,
    { grant_type: "authorization_code", code, redirect_uri: app.redirectUri, code_verifier: verifier },
    fetchFn,
  );
}

export function refreshTokens(p: Provider, app: OAuthApp, refresh: string, fetchFn = fetch) {
  return tokenCall(p, app, { grant_type: "refresh_token", refresh_token: refresh, client_id: app.clientId }, fetchFn);
}

/** The account the token belongs to: X username or GitHub login. */
export async function whoAmI(p: Provider, access: string, fetchFn = fetch): Promise<string> {
  const url = p === "x" ? "https://api.x.com/2/users/me" : "https://api.github.com/user";
  const r = await fetchFn(url, {
    headers: {
      authorization: `Bearer ${access}`,
      accept: p === "x" ? "application/json" : "application/vnd.github+json",
      "user-agent": "devagent",
    },
  });
  if (!r.ok) throw new Error(`${p} account lookup failed: ${r.status}`);
  const j = (await r.json()) as { data?: { username?: string }; login?: string };
  const name = p === "x" ? j.data?.username : j.login;
  if (!name) throw new Error(`${p} account lookup: no name`);
  return name;
}

/** Stored credential: JSON tokens, or a bare token string from older setups (`pnpm creds`). */
export function parseTokens(stored: string): Tokens {
  if (stored.startsWith("{")) {
    try {
      const t = JSON.parse(stored) as Tokens;
      if (typeof t.access === "string") return t;
    } catch {
      /* fall through: treat as a bare token */
    }
  }
  return { access: stored };
}

export function appsFromEnv(env: Record<string, string | undefined> = process.env): Partial<Record<Provider, OAuthApp>> {
  const base = (env.PUBLIC_URL || `http://${env.WEB_HOST || "127.0.0.1"}:${env.WEB_PORT || 3000}`).replace(/\/+$/, "");
  const out: Partial<Record<Provider, OAuthApp>> = {};
  if (env.X_CLIENT_ID && env.X_CLIENT_SECRET)
    out.x = { clientId: env.X_CLIENT_ID, clientSecret: env.X_CLIENT_SECRET, redirectUri: `${base}/oauth/callback/x` };
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
    out.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      redirectUri: `${base}/oauth/callback/github`,
    };
  return out;
}
