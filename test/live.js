// Calls every tool once against the real API, through the built server over
// stdio, like an AI client. Consumes about 65 credits.
//   SCRAPING_BOT_USERNAME=... SCRAPING_BOT_API_KEY=... npm run test:live
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CASES = [
  ["scrape_raw_html", { url: "https://httpbin.org/html", maxChars: 300 }],
  ["scrape_retail", { url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html" }],
  ["scrape_real_estate", { url: "https://www.immoweb.be/fr/annonce/maison/a-vendre/mouscron/7700/21916072", premiumProxy: true }],
  ["scrape_booking", { url: "https://www.booking.com/searchresults.html?ss=Paris&dest_id=-1456928&dest_type=city&group_adults=2", premiumProxy: true }],
  ["scrape_grocery", { url: "https://www.carrefour.fr/p/evian-eau-minerale-naturelle-3068320120259", premiumProxy: true }],
  ["scrape_search_engine", { search: "web scraping api" }],
  ["scrape_social_media", { scraper: "twitterProfile", url: "https://x.com/OpenAI", number_of_tweets: 5 }],
];

if (!process.env.SCRAPING_BOT_USERNAME || !process.env.SCRAPING_BOT_API_KEY) {
  console.error("Set SCRAPING_BOT_USERNAME and SCRAPING_BOT_API_KEY.");
  process.exit(1);
}

const client = new Client({ name: "live-test", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname], env: process.env }));
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

let failures = 0;
for (const [name, args] of CASES) {
  const start = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = result.content[0]?.text ?? "";
  if (result.isError) failures++;
  console.log(`${result.isError ? "ERROR" : "OK   "} ${name.padEnd(22)} ${Math.round((Date.now() - start) / 1000)}s  ${text.replace(/\s+/g, " ").slice(0, 160)}`);
}
await client.close();
process.exit(failures ? 1 : 0);
