// OAuth of the remote mode, with an in-memory store instead of the API:
// registration, authorization (signed request to the website), PKCE token
// exchange, tool call with the access token, refresh and revocation.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { jwtVerify } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "../dist/http.js";

const SECRET = "test-oauth-secret-0123456789";
const REDIRECT = "http://localhost:6274/callback";
const sha = (v) => createHash("sha256").update(v).digest("hex");

// What the API does, in memory: tokens are only kept as hashes
function memoryStore() {
  const clients = new Map();
  const codes = new Map();
  const grants = [];
  const issue = (grant) => {
    const access = "sbo_at_" + randomBytes(16).toString("hex");
    const refresh = "sbo_rt_" + randomBytes(16).toString("hex");
    Object.assign(grant, { accessHash: sha(access), refreshHash: sha(refresh), accessExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: grant.scopes.join(" ") };
  };
  return {
    clients, codes, grants,
    // the website + API side: the signed-in user consents
    approve(request, username) {
      const code = "code_" + randomBytes(8).toString("hex");
      codes.set(sha(code), { ...request, username, expiresAt: Date.now() + 600_000 });
      return code;
    },
    async getClient(id) { return clients.get(id); },
    async registerClient(client) { clients.set(client.client_id, client); return client; },
    async codeChallenge(code, clientId) {
      const c = codes.get(sha(code));
      return c && c.clientId === clientId && c.expiresAt > Date.now() ? c.codeChallenge : undefined;
    },
    async exchangeCode({ code, clientId, redirectUri }) {
      const c = codes.get(sha(code));
      if (!c || c.clientId !== clientId || (redirectUri && redirectUri !== c.redirectUri)) return undefined;
      codes.delete(sha(code));
      const grant = { username: c.username, clientId, scopes: c.scopes, revoked: false };
      grants.push(grant);
      return issue(grant);
    },
    async refresh({ refreshToken, clientId }) {
      const grant = grants.find((g) => g.refreshHash === sha(refreshToken) && g.clientId === clientId && !g.revoked);
      return grant ? issue(grant) : undefined;
    },
    async introspect(token) {
      const grant = grants.find((g) => g.accessHash === sha(token) && !g.revoked);
      return grant ? { active: true, username: grant.username, clientId: grant.clientId, scopes: grant.scopes, expiresAt: grant.accessExpiresAt } : { active: false };
    },
    async revoke({ token }) {
      for (const g of grants) if (g.accessHash === sha(token) || g.refreshHash === sha(token)) g.revoked = true;
    },
  };
}

async function start() {
  const store = memoryStore();
  const apiCalls = [];
  const fetchImpl = async (url, init) => {
    apiCalls.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ plan: "Startup", credits: { remaining: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const app = createHttpApp({
    apiBase: "https://api.test",
    fetchImpl,
    log: () => {},
    oauth: { secret: SECRET, publicUrl: "http://localhost", siteUrl: "https://site.test", store },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, apiCalls, close: () => new Promise((r) => server.close(r)) };
}

const form = (data) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) });

test("OAuth: metadata, registration, consent, PKCE token, tool call, refresh, revocation", async () => {
  const s = await start();

  // Discovery
  const unauthenticated = await fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate"), /^Bearer resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/);
  const resource = await (await fetch(s.base + "/.well-known/oauth-protected-resource/mcp")).json();
  assert.deepEqual(resource.authorization_servers, ["http://localhost/"]);
  const metadata = await (await fetch(s.base + "/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.authorization_endpoint, "http://localhost/authorize");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);

  // Dynamic client registration
  const reg = await fetch(s.base + "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();

  // Authorization: redirected to the website with a signed request
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = await fetch(s.base + "/authorize?" + new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "scrape" }), { redirect: "manual" });
  assert.equal(auth.status, 302);
  const location = new URL(auth.headers.get("location"));
  assert.equal(location.origin + location.pathname, "https://site.test/oauth/consent");
  const { payload } = await jwtVerify(location.searchParams.get("request"), new TextEncoder().encode(SECRET), { audience: "scraping-bot-oauth-request" });
  assert.equal(payload.clientId, client_id);
  assert.equal(payload.clientName, "Claude");
  assert.equal(payload.redirectUri, REDIRECT);
  assert.equal(payload.codeChallenge, challenge);
  assert.equal(payload.state, "xyz");
  // a request signed with another secret is refused
  await assert.rejects(jwtVerify(location.searchParams.get("request"), new TextEncoder().encode("other"), { audience: "scraping-bot-oauth-request" }));

  // The user consents on the website: the API creates the code
  const code = s.store.approve(payload, "ada");

  // A wrong PKCE verifier is refused, the right one gets the tokens
  const bad = await fetch(s.base + "/token", form({ grant_type: "authorization_code", code, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier", client_id, redirect_uri: REDIRECT }));
  assert.equal(bad.status, 400);
  const tokenRes = await fetch(s.base + "/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }));
  assert.equal(tokenRes.status, 200);
  const tokens = await tokenRes.json();
  assert.match(tokens.access_token, /^sbo_at_/);
  // the code works once
  assert.equal((await fetch(s.base + "/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }))).status, 400);

  // Tool call with the access token: the API gets the same token
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  assert.equal((await client.listTools()).tools.length, 10);
  await client.callTool({ name: "get_account", arguments: {} });
  assert.equal(s.apiCalls.at(-1).headers.Authorization, `Bearer ${tokens.access_token}`);
  await client.close();

  // An unknown token: 401 with the metadata URL
  const invalid = await fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer sbo_at_nope" }, body: "{}" });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get("www-authenticate"), /invalid_token/);

  // Refresh: new tokens, the old access token stops working
  const refreshed = await (await fetch(s.base + "/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }))).json();
  assert.notEqual(refreshed.access_token, tokens.access_token);
  assert.equal((await s.store.introspect(tokens.access_token)).active, false);

  // Revocation
  assert.equal((await fetch(s.base + "/revoke", form({ token: refreshed.access_token, client_id }))).status, 200);
  const revoked = await fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${refreshed.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(revoked.status, 401);

  await s.close();
});

test("without OAuth, the 401 asks for the API key (Basic)", async () => {
  const app = createHttpApp({ apiBase: "https://api.test", log: () => {} });
  const server = await new Promise((resolve) => { const srv = app.listen(0, "127.0.0.1", () => resolve(srv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /^Basic/);
  assert.equal((await fetch(base + "/.well-known/oauth-authorization-server")).status, 404);
  await new Promise((r) => server.close(r));
});
