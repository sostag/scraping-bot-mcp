// OAuth 2.1 for the remote mode ("Sign in with ScrapingBot"): claude.ai and
// other MCP clients get an access token instead of asking for an API key.
//
// The MCP server is the authorization server (routes of the SDK: metadata,
// /register, /authorize, /token, /revoke, PKCE), but stores nothing: clients,
// codes and grants live in the ScrapingBot API (internal routes protected by
// OAUTH_SECRET). The user signs in and consents on the website:
//
//   client → /authorize → website /oauth/consent?request=<signed request>
//          → the API creates a code for the signed-in user → client redirect_uri
//   client → /token (code + PKCE verifier) → access and refresh tokens
//   client → /mcp with "Authorization: Bearer <access token>" → the API accepts
//            the same token on /scrape and /account
import type { Response } from "express";
import { SignJWT } from "jose";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const OAUTH_SCOPE = "scrape";
// The signed request sent to the website: valid as long as it takes to sign in
const REQUEST_TTL_SECONDS = 15 * 60;
// Active access tokens are kept briefly, to avoid one API call per tool call
const INTROSPECTION_CACHE_MS = 30_000;

export interface Introspection {
  active: boolean;
  username?: string;
  clientId?: string;
  scopes?: string[];
  expiresAt?: number;
}

// Where OAuth data lives: the API in production, memory in the tests
export interface OAuthStore {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull>;
  codeChallenge(code: string, clientId: string): Promise<string | undefined>;
  exchangeCode(params: { code: string; clientId: string; redirectUri?: string }): Promise<OAuthTokens | undefined>;
  refresh(params: { refreshToken: string; clientId: string }): Promise<OAuthTokens | undefined>;
  introspect(token: string): Promise<Introspection>;
  revoke(params: { token: string; clientId: string }): Promise<void>;
}

// The ScrapingBot API's internal OAuth routes
export function apiOAuthStore({
  apiBase,
  secret,
  fetchImpl = fetch,
}: {
  apiBase: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): OAuthStore {
  async function call<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
    let response: globalThis.Response;
    try {
      response = await fetchImpl(`${apiBase}/oauth/internal${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-oauth-secret": secret },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ServerError("The ScrapingBot API is unreachable");
    }
    if (response.status >= 500 || response.status === 401) {
      throw new ServerError(`The ScrapingBot API answered ${response.status}`);
    }
    const data = (await response.json().catch(() => ({}))) as T;
    return { status: response.status, data };
  }

  return {
    async getClient(clientId) {
      const { status, data } = await call<OAuthClientInformationFull>(`/clients/${encodeURIComponent(clientId)}`);
      return status === 200 ? data : undefined;
    },
    async registerClient(client) {
      const { status, data } = await call<OAuthClientInformationFull>("/clients", client);
      if (status !== 201) throw new ServerError("Could not register the client");
      return data;
    },
    async codeChallenge(code, clientId) {
      const { status, data } = await call<{ codeChallenge: string }>("/code-challenge", { code, clientId });
      return status === 200 ? data.codeChallenge : undefined;
    },
    async exchangeCode(params) {
      const { status, data } = await call<OAuthTokens>("/token", { grantType: "authorization_code", ...params });
      return status === 200 ? data : undefined;
    },
    async refresh(params) {
      const { status, data } = await call<OAuthTokens>("/token", { grantType: "refresh_token", ...params });
      return status === 200 ? data : undefined;
    },
    async introspect(token) {
      const { status, data } = await call<Introspection>("/introspect", { token });
      return status === 200 ? data : { active: false };
    },
    async revoke(params) {
      await call("/revoke", params);
    },
  };
}

export class ScrapingBotOAuthProvider implements OAuthServerProvider {
  private readonly cache = new Map<string, { info: Introspection; until: number }>();

  constructor(
    private readonly store: OAuthStore,
    private readonly options: { secret: string; siteUrl: string; issuerUrl: string },
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.getClient(clientId),
      registerClient: (client) => this.store.registerClient(client as OAuthClientInformationFull),
    };
  }

  // The website shows the consent page; the request is signed so that the API
  // can trust the client, redirect URI and PKCE challenge it carries
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const request = await new SignJWT({
      clientId: client.client_id,
      clientName: client.client_name || null,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state ?? null,
      scopes: params.scopes?.length ? params.scopes : [OAUTH_SCOPE],
      resource: params.resource?.href ?? null,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(this.options.issuerUrl)
      .setAudience("scraping-bot-oauth-request")
      .setIssuedAt()
      .setExpirationTime(`${REQUEST_TTL_SECONDS}s`)
      .sign(new TextEncoder().encode(this.options.secret));
    res.redirect(302, `${this.options.siteUrl}/oauth/consent?request=${encodeURIComponent(request)}`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const challenge = await this.store.codeChallenge(code, client.client_id);
    if (!challenge) throw new InvalidGrantError("Invalid or expired authorization code");
    return challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const tokens = await this.store.exchangeCode({ code, clientId: client.client_id, redirectUri });
    if (!tokens) throw new InvalidGrantError("Invalid or expired authorization code");
    return tokens;
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const tokens = await this.store.refresh({ refreshToken, clientId: client.client_id });
    if (!tokens) throw new InvalidGrantError("Invalid or expired refresh token");
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const now = Date.now();
    let cached = this.cache.get(token);
    if (!cached || cached.until < now) {
      const info = await this.store.introspect(token);
      cached = { info, until: now + INTROSPECTION_CACHE_MS };
      if (info.active) this.cache.set(token, cached);
      if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!);
    }
    const { info } = cached;
    if (!info.active || !info.username || (info.expiresAt && info.expiresAt * 1000 < now)) {
      this.cache.delete(token);
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: info.clientId ?? "",
      scopes: info.scopes ?? [OAUTH_SCOPE],
      expiresAt: info.expiresAt,
      extra: { username: info.username },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.cache.delete(request.token);
    await this.store.revoke({ token: request.token, clientId: client.client_id });
  }
}
