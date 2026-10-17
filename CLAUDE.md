# CLAUDE.md

MCP server for the ScrapingBot API (`sostag/scraping-bot-mcp`), in TypeScript. Users run it with `npx -y github:sostag/scraping-bot-mcp`: `dist/` is not committed, npm builds it on install through the `prepare` script, so the build must never fail (`npm test` builds first).

- `src/api.ts`: HTTP client (Basic Auth) and API error formatting (`{ error: "..." }` or `{ error: { message, details, suggestedUrl } }`; a scrape can also answer 200 with `error`).
- `src/tools.ts`: the tools. Page tools post `{ url, options }` to `/scrape/<endpoint>`; Search Engine posts `engine`, `search`, `format: "json"`…; Social Media posts to `/scrape/data-scraper` then polls `/scrape/data-scraper-response` (202 while pending; the first check must wait at least a second).
- `src/index.ts`: reads `SCRAPING_BOT_USERNAME`, `SCRAPING_BOT_API_KEY` (and optional `SCRAPING_BOT_API_URL`) and starts the stdio server.

Tests: `npm test` (fake API, no credit) and `npm run test:live` (real API, about 65 credits, credentials in the environment). The API itself lives in `../scrapingbot-scraper`; keep tool descriptions and credit costs in line with `api/middleware/rateLimiterMongo.js`.
