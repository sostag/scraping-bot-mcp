// Remote mode: the same tools over Streamable HTTP (POST /mcp), for clients
// that connect to a URL (Cursor, agent frameworks...). Stateless: every request
// carries the user's credentials, gets its own API client and MCP server, and
// nothing is kept between requests. Nothing secret is logged.
import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, DEFAULT_API_BASE, VERSION } from "./api.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools.js";
import { apiOAuthStore, OAUTH_SCOPE, ScrapingBotOAuthProvider, type OAuthStore } from "./oauth.js";

export interface HttpOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  // Header set by the hosting's proxy with the client's IP (App Platform:
  // do-connecting-ip). Empty: the socket address.
  clientIpHeader?: string;
  // Shared with the API (INTERNAL_PROXY_SECRET): lets it trust the forwarded
  // client IP, so that its per-IP limits see each client, not this server.
  internalProxySecret?: string;
  requestsPerMinute?: number;
  maxBodyBytes?: number;
  log?: (line: string) => void;
  // OAuth ("Sign in with ScrapingBot"), off without a secret: see src/oauth.ts
  oauth?: {
    secret: string;
    // Public URL of this server (issuer), e.g. https://mcp.scraping-bot.io
    publicUrl: string;
    // Website with the consent page, e.g. https://www.scraping-bot.io
    siteUrl: string;
    // Default: the API's internal OAuth routes
    store?: OAuthStore;
  };
}

const MAX_BODY_BYTES = 64 * 1024;
const REQUESTS_PER_MINUTE = 120;
const REALM = 'Basic realm="ScrapingBot MCP", charset="UTF-8"';

function jsonRpcError(res: Response, status: number, message: string, headers: Record<string, string> = {}) {
  res.status(status).set(headers).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

// "Authorization: Basic base64(username:apiKey)"
export function basicCredentials(header: string | undefined): { username: string; apiKey: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const at = decoded.indexOf(":");
  if (at <= 0 || at === decoded.length - 1) return null;
  return { username: decoded.slice(0, at), apiKey: decoded.slice(at + 1) };
}

// Basic Auth, or the plain headers X-ScrapingBot-Username and
// X-ScrapingBot-Api-Key (simpler to write in a client's configuration)
export function requestCredentials(req: Request): { username: string; apiKey: string } | null {
  const basic = basicCredentials(req.get("authorization"));
  if (basic) return basic;
  const username = req.get("x-scrapingbot-username")?.trim();
  const apiKey = req.get("x-scrapingbot-api-key")?.trim();
  return username && apiKey ? { username, apiKey } : null;
}

export function createHttpApp(options: HttpOptions = {}) {
  const {
    apiBase = DEFAULT_API_BASE,
    fetchImpl = fetch,
    clientIpHeader = "",
    internalProxySecret = "",
    requestsPerMinute = REQUESTS_PER_MINUTE,
    maxBodyBytes = MAX_BODY_BYTES,
    log = (line: string) => console.log(line),
    oauth,
  } = options;

  const clientIp = (req: Request): string => {
    const forwarded = clientIpHeader ? req.get(clientIpHeader) : undefined;
    return (forwarded?.split(",")[0].trim() || req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  };

  const app = express();
  app.disable("x-powered-by");
  const ipKey = (req: Request) => ipKeyGenerator(clientIp(req));

  // Access log: no headers, no body, no credentials; the user as a short hash
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const user = requestCredentials(req)?.username;
      const who = user ? createHash("sha256").update(user).digest("hex").slice(0, 8) : "-";
      log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms user=${who}`);
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: VERSION });
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: requestsPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: ipKey,
    handler: (_req, res) => jsonRpcError(res, 429, "Too many requests: slow down and retry in a minute."),
  });

  // inflate: false refuses compressed bodies (MCP clients send plain JSON):
  // no decompression bomb, and body-parser's DoS on compressed bodies
  // (GHSA-27r3-jxmh-p828, fixed in 2.4.0) cannot be reached
  // OAuth: metadata, /register, /authorize, /token, /revoke (SDK), each with
  // its own per-IP limit keyed on the real client IP
  let bearerAuth: express.RequestHandler | null = null;
  let resourceMetadataUrl: string | null = null;
  if (oauth?.secret) {
    const issuerUrl = new URL(oauth.publicUrl);
    const resourceServerUrl = new URL("/mcp", issuerUrl);
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
    const provider = new ScrapingBotOAuthProvider(
      oauth.store ?? apiOAuthStore({ apiBase, secret: oauth.secret, fetchImpl }),
      { secret: oauth.secret, siteUrl: oauth.siteUrl.replace(/\/$/, ""), issuerUrl: issuerUrl.href },
    );
    const limited = { rateLimit: { keyGenerator: ipKey } };
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        resourceServerUrl,
        scopesSupported: [OAUTH_SCOPE],
        resourceName: "ScrapingBot",
        serviceDocumentationUrl: new URL("https://www.scraping-bot.io/mcp-server"),
        authorizationOptions: limited,
        tokenOptions: limited,
        clientRegistrationOptions: limited,
        revocationOptions: limited,
      }),
    );
    bearerAuth = requireBearerAuth({ verifier: provider, requiredScopes: [OAUTH_SCOPE], resourceMetadataUrl });
  }

  // OAuth access token: checked by the SDK (401 with WWW-Authenticate when
  // invalid), then used for the API calls instead of an API key
  const bearer: express.RequestHandler = (req, res, next) => {
    if (bearerAuth && /^Bearer\s/i.test(req.get("authorization") ?? "")) return bearerAuth(req, res, next);
    next();
  };

  app.post("/mcp", limiter, bearer, express.json({ limit: maxBodyBytes, inflate: false }), async (req, res) => {
    const accessToken = (req as Request & { auth?: { token: string } }).auth?.token;
    const credentials = accessToken ? null : requestCredentials(req);
    if (!accessToken && !credentials) {
      return jsonRpcError(
        res,
        401,
        "Authentication required: sign in with ScrapingBot (OAuth), or send your ScrapingBot username and API key in the X-ScrapingBot-Username and X-ScrapingBot-Api-Key headers, or with Basic Auth.",
        { "WWW-Authenticate": resourceMetadataUrl ? `Bearer resource_metadata="${resourceMetadataUrl}"` : REALM },
      );
    }

    const ip = clientIp(req);
    const client = createClient({
      ...(accessToken ? { accessToken } : credentials!),
      baseUrl: apiBase,
      fetchImpl,
      userAgent: `scraping-bot-mcp/${VERSION} (http)`,
      extraHeaders: internalProxySecret
        ? { "x-real-client-ip": ip, "x-internal-proxy-secret": internalProxySecret }
        : {},
    });
    const server = new McpServer({ name: "scraping-bot", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
    registerTools(server, client);
    // Stateless: no session id; one JSON response per request
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log(`POST /mcp failed: ${(error as Error).message}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });

  // Stateless mode: no server-to-client stream, no session to delete
  app.all("/mcp", (_req, res) => jsonRpcError(res, 405, "Method not allowed: use POST.", { Allow: "POST" }));

  // Invalid JSON, body too large
  app.use((error: { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (error?.type === "entity.too.large") return jsonRpcError(res, 413, `Request too large (${maxBodyBytes} bytes max).`);
    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    next(error);
  });

  return app;
}
