# ScrapingBot MCP server

Let Claude, Cursor and any [Model Context Protocol](https://modelcontextprotocol.io) client scrape the web with [ScrapingBot](https://www.scraping-bot.io): page HTML, products, real estate listings, hotels and rentals, search engine results and public social media pages.

You need a ScrapingBot account: the free plan gives 500 credits a month. Your username and API key are in your [dashboard](https://www.scraping-bot.io/dashboard).

## Installation

The server runs with `npx` from npm ([`@sostag/scraping-bot-mcp`](https://www.npmjs.com/package/@sostag/scraping-bot-mcp)): nothing to install besides Node.js 18 or later.

### Claude Code

```bash
claude mcp add scraping-bot \
  -e SCRAPING_BOT_USERNAME=your_username \
  -e SCRAPING_BOT_API_KEY=your_api_key \
  -- npx -y @sostag/scraping-bot-mcp
```

### Claude Desktop

Add the server to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "scraping-bot": {
      "command": "npx",
      "args": ["-y", "@sostag/scraping-bot-mcp"],
      "env": {
        "SCRAPING_BOT_USERNAME": "your_username",
        "SCRAPING_BOT_API_KEY": "your_api_key"
      }
    }
  }
}
```

### Cursor and other clients

Use the same `command`, `args` and `env` in the client's MCP settings (Cursor: `~/.cursor/mcp.json`).

To pin a version, add it: `@sostag/scraping-bot-mcp@1.2.0`. The versions are listed on [npm](https://www.npmjs.com/package/@sostag/scraping-bot-mcp?activeTab=versions) and in the [releases](https://github.com/sostag/scraping-bot-mcp/releases). The server also runs straight from this repository, built on install (needs Git): `npx -y github:sostag/scraping-bot-mcp`.

## Tools

| Tool | What it returns | Credits |
| --- | --- | --- |
| `scrape_raw_html` | HTML of any page (truncated to `maxChars`, 100,000 by default) | 1, 5 with `useChrome`, 10 with `premiumProxy`, 25 with both |
| `scrape_retail` | Product: title, price, currency, images, brand, stock, EAN… | same |
| `scrape_real_estate` | Listing: price or rent, surface, rooms, location, images… | same |
| `scrape_booking` | Hotel or rental page, or a search results page (Booking.com, Airbnb, Expedia, Hotels.com, Abritel) | same |
| `scrape_grocery` | Grocery product: price, image, brand, nutritional values | same |
| `scrape_search_engine` | Google or Bing results as JSON | 30 |
| `scrape_social_media` | Public Instagram, TikTok, Facebook, LinkedIn, X/Twitter and Threads profiles, posts and searches | 30 |
| `get_social_media_result` | The result of a social media scrape that was still pending | 0 |

Page tools take `url` plus the optional `useChrome` (JavaScript sites), `premiumProxy` (sites that block regular proxies) and `proxyCountry` (two-letter code, with `premiumProxy`). Some sites always get the right options from the API.

A request blocked by the site (403, captcha…) is retried once with a premium proxy, billed at the premium price only if it succeeds; the result then says so (`notice`, or a note above the HTML). Pass `premiumFallback: false` to turn this off.

Failed requests are refunded. Social media scrapes take from a few seconds to several minutes: `scrape_social_media` waits about a minute, then returns a `responseId` that `get_social_media_result` uses later, at no cost.

When a URL is malformed (missing `https://`, missing `/` after the domain…), the error explains it and gives the corrected address.

## Security

Your API key stays on your computer: it is read from the environment and only sent to `https://api.scraping-bot.io`. Every call made by your AI agent uses your credits; you can follow them in your dashboard.

## Development

```bash
npm install
npm test                 # builds, then tests every tool against a fake API (no credit used)
SCRAPING_BOT_USERNAME=... SCRAPING_BOT_API_KEY=... npm run test:live   # real API, about 65 credits
```

`src/` is TypeScript, compiled to `dist/` (not committed): the npm package ships it, and `npx github:...` builds it on install through the `prepare` script.

Releases are automatic: every push to `main` that changes the code builds, tests and publishes a `vX.Y.Z` tag, a GitHub release and the npm package (`.github/workflows/release.yml`, with the `NPM_TOKEN` secret). The commit messages choose the version: `feat:` raises the minor version, `fix:` and the others the patch version, `!` or `BREAKING CHANGE` the major version. Nothing is committed to `main` (its `package.json` keeps `0.0.0-dev`), so there is nothing to pull. Add `[skip release]` to a commit message to push without releasing. `SCRAPING_BOT_API_URL` points the server to another API (local development).

## License

MIT
