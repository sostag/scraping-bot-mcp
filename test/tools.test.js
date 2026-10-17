// Unit tests: the MCP tools against a fake ScrapingBot API (no network, no credit).
import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient } from "../dist/api.js";
import { registerTools } from "../dist/tools.js";

function reply(status, body, contentType = "application/json") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

// routes: { "POST /scrape/retail": (body) => Response | [Response, ...] }
async function connect(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const key = `${init.method} ${pathname}`;
    const body = init.body ? JSON.parse(init.body) : Object.fromEntries(searchParams);
    calls.push({ key, body, headers: init.headers });
    const handler = routes[key];
    if (!handler) return reply(404, { url: `${pathname} not found` });
    return handler(body, calls.filter((c) => c.key === key).length);
  };
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, createClient({ username: "user", apiKey: "key", baseUrl: "https://api.test", fetchImpl }), { socialWaitMs: 50, pollIntervalMs: 10 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content[0].text, isError: result.isError === true };
  };
  return { client, call, calls };
}

test("lists the tools", async () => {
  const { client } = await connect({});
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "get_social_media_result", "scrape_booking", "scrape_grocery", "scrape_raw_html", "scrape_real_estate",
    "scrape_retail", "scrape_search_engine", "scrape_social_media",
  ]);
});

test("retail sends the url and options with Basic Auth", async () => {
  const { call, calls } = await connect({ "POST /scrape/retail": () => reply(200, { data: { title: "Phone", price: 199 } }) });
  const result = await call("scrape_retail", { url: "https://shop.test/p/1", premiumProxy: true, proxyCountry: "fr" });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.text).data.price, 199);
  assert.deepEqual(calls[0].body, { url: "https://shop.test/p/1", options: { premiumProxy: true, proxyCountry: "FR" } });
  assert.equal(calls[0].headers.Authorization, "Basic " + Buffer.from("user:key").toString("base64"));
});

test("a scrape that fails is reported as an error with its data", async () => {
  const { call } = await connect({ "POST /scrape/retail": () => reply(200, { error: "Error probably blocked, retry or use premiumProxy", data: { title: "" } }) });
  const result = await call("scrape_retail", { url: "https://shop.test/p/1" });
  assert.equal(result.isError, true);
  assert.match(result.text, /probably blocked/);
  assert.match(result.text, /Returned data/);
});

test("an invalid URL shows the API explanation and the suggested URL", async () => {
  const { call } = await connect({
    "POST /scrape/real-estate": () => reply(400, { error: { code: 400, message: "Invalid URL: unknown domain extension \".frdp\"", details: "A \"/\" is probably missing.", suggestedUrl: "https://www.site.fr/dp" } }),
  });
  const result = await call("scrape_real_estate", { url: "https://www.site.frdp" });
  assert.equal(result.isError, true);
  assert.match(result.text, /Suggested URL: https:\/\/www\.site\.fr\/dp/);
});

test("raw html is returned as is and truncated", async () => {
  const html = "<html>" + "x".repeat(500) + "</html>";
  const { call, calls } = await connect({ "POST /scrape/raw-html": () => reply(200, html, "text/html") });
  const full = await call("scrape_raw_html", { url: "https://site.test", useChrome: true });
  assert.equal(full.text, html);
  assert.deepEqual(calls[0].body.options, { useChrome: true });
  const cut = await call("scrape_raw_html", { url: "https://site.test", maxChars: 100 });
  assert.match(cut.text, /\[Truncated: 513 characters in total/);
});

test("search engine sends the API parameters", async () => {
  const { call, calls } = await connect({ "POST /scrape/search-engine": () => reply(200, { organic: [{ title: "A", link: "https://a.test" }] }) });
  const result = await call("scrape_search_engine", { search: "web scraping", domainCountry: "fr", resultLang: "fr" });
  assert.equal(result.isError, false);
  assert.deepEqual(calls[0].body, { engine: "google", search: "web scraping", searchType: "search", format: "json", domainCountry: "FR", resultLang: "fr" });
});

test("social media waits for the result", async () => {
  const { call, calls } = await connect({
    "POST /scrape/data-scraper": () => reply(200, { responseId: "s_1" }),
    "GET /scrape/data-scraper-response": (_body, n) => (n < 2 ? reply(202, { status: "pending" }) : reply(200, [{ account: "acme", followers: 10 }])),
  });
  const result = await call("scrape_social_media", { scraper: "instagramProfile", account: "acme" });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.text)[0].followers, 10);
  assert.deepEqual(calls[0].body, { scraper: "instagramProfile", account: "acme" });
  assert.deepEqual(calls.at(-1).body, { scraper: "instagramProfile", responseId: "s_1" });
});

test("social media hands back the responseId when still pending", async () => {
  const { call } = await connect({
    "POST /scrape/data-scraper": () => reply(200, { responseId: "s_2" }),
    "GET /scrape/data-scraper-response": () => reply(202, { status: "pending" }),
  });
  const pending = await call("scrape_social_media", { scraper: "tiktokProfile", url: "https://www.tiktok.com/@tiktok" });
  assert.equal(pending.isError, false);
  assert.deepEqual(
    (({ status, scraper, responseId }) => ({ status, scraper, responseId }))(JSON.parse(pending.text)),
    { status: "pending", scraper: "tiktokProfile", responseId: "s_2" },
  );
  const again = await call("get_social_media_result", { scraper: "tiktokProfile", responseId: "s_2" });
  assert.match(again.text, /"pending"/);
});

test("a social media error is reported", async () => {
  const { call } = await connect({ "POST /scrape/data-scraper": () => reply(400, { error: "An error occured during scraping: You need to provide a valid url" }) });
  const result = await call("scrape_social_media", { scraper: "instagramPost", url: "nope" });
  assert.equal(result.isError, true);
  assert.match(result.text, /valid url/);
});
