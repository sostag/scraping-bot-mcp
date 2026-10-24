// Remote (HTTP) mode against a fake ScrapingBot API: no network, no credit.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp, basicCredentials } from "../dist/http.js";

const basic = (user, key) => "Basic " + Buffer.from(`${user}:${key}`).toString("base64");

async function start(options = {}) {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ plan: "Startup", credits: { remaining: 42 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const app = createHttpApp({ apiBase: "https://api.test", fetchImpl, log: (l) => logs.push(l), ...options });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, logs, close: () => new Promise((r) => server.close(r)) };
}

async function connect(base, headers) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers } }));
  return client;
}

test("Basic credentials are parsed, and refused when incomplete", () => {
  assert.deepEqual(basicCredentials(basic("ada", "k:ey")), { username: "ada", apiKey: "k:ey" });
  assert.equal(basicCredentials("Bearer abc"), null);
  assert.equal(basicCredentials(basic("", "key")), null);
  assert.equal(basicCredentials(basic("ada", "")), null);
  assert.equal(basicCredentials(undefined), null);
});

test("without credentials: 401 with WWW-Authenticate", async () => {
  const s = await start();
  const res = await fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /^Basic/);
  await s.close();
});

test("lists the tools and the instructions, and calls the API with the user's key", async () => {
  const s = await start({ internalProxySecret: "internal-secret", clientIpHeader: "do-connecting-ip" });
  const client = await connect(s.base, { Authorization: basic("ada", "secret-key-123"), "do-connecting-ip": "203.0.113.7" });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  assert.match(client.getInstructions(), /scrape_retail/);
  const result = await client.callTool({ name: "get_account", arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).credits.remaining, 42);
  const call = s.calls.at(-1);
  assert.equal(call.url, "https://api.test/account?");
  assert.equal(call.headers.Authorization, basic("ada", "secret-key-123"));
  assert.match(call.headers["User-Agent"], /^scraping-bot-mcp\/.* \(http\)$/);
  assert.equal(call.headers["x-real-client-ip"], "203.0.113.7");
  assert.equal(call.headers["x-internal-proxy-secret"], "internal-secret");
  await client.close();
  // nothing secret in the access log
  const logs = s.logs.join("\n");
  assert.doesNotMatch(logs, /secret-key-123|ada|internal-secret/);
  assert.match(logs, /POST \/mcp 200/);
  await s.close();
});

test("without the internal secret, the client IP is not forwarded", async () => {
  const s = await start();
  const client = await connect(s.base, { Authorization: basic("ada", "k") });
  await client.callTool({ name: "get_account", arguments: {} });
  assert.equal(s.calls.at(-1).headers["x-real-client-ip"], undefined);
  await client.close();
  await s.close();
});

test("body too large: 413; invalid JSON: 400; GET: 405; health", async () => {
  const s = await start({ maxBodyBytes: 1024 });
  const post = (body) => fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: basic("ada", "k") }, body });
  assert.equal((await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(5000) } }))).status, 413);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await fetch(s.base + "/mcp")).status, 405);
  const health = await fetch(s.base + "/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  await s.close();
});

test("requests per IP are limited", async () => {
  const s = await start({ requestsPerMinute: 2 });
  const post = () => fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await post()).status);
  assert.deepEqual(statuses, [401, 401, 429]);
  await s.close();
});

test("the plain username and API key headers work too", async () => {
  const s = await start();
  const client = await connect(s.base, { "X-ScrapingBot-Username": "ada", "X-ScrapingBot-Api-Key": "secret-key-123" });
  await client.callTool({ name: "get_account", arguments: {} });
  assert.equal(s.calls.at(-1).headers.Authorization, basic("ada", "secret-key-123"));
  await client.close();
  assert.doesNotMatch(s.logs.join("\n"), /secret-key-123|ada/);
  await s.close();
});

test("compressed bodies are refused", async () => {
  const { gzipSync } = await import("node:zlib");
  const s = await start();
  const res = await fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", accept: "application/json, text/event-stream", authorization: basic("ada", "k") }, body: gzipSync(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })) });
  assert.equal(res.status, 415);
  await s.close();
});
