#!/usr/bin/env node
// Starts the remote (HTTP) mode: see src/http.ts. Environment:
//   PORT                     default 8080
//   SCRAPING_BOT_API_URL     default https://api.scraping-bot.io
//   CLIENT_IP_HEADER         header with the client's IP set by the proxy (App Platform: do-connecting-ip)
//   INTERNAL_PROXY_SECRET    shared with the API, to forward the client's IP
//   OAUTH_SECRET             shared with the API: turns OAuth on (src/oauth.ts)
//   PUBLIC_URL, SITE_URL     default https://mcp.scraping-bot.io, https://www.scraping-bot.io
import { createHttpApp } from "./http.js";
import { DEFAULT_API_BASE, VERSION } from "./api.js";

const port = Number(process.env.PORT) || 8080;
const app = createHttpApp({
  apiBase: process.env.SCRAPING_BOT_API_URL || DEFAULT_API_BASE,
  clientIpHeader: process.env.CLIENT_IP_HEADER || "",
  internalProxySecret: process.env.INTERNAL_PROXY_SECRET || "",
  // OAuth: on when OAUTH_SECRET (shared with the API) is set
  oauth: process.env.OAUTH_SECRET
    ? {
        secret: process.env.OAUTH_SECRET,
        publicUrl: process.env.PUBLIC_URL || "https://mcp.scraping-bot.io",
        siteUrl: process.env.SITE_URL || "https://www.scraping-bot.io",
      }
    : undefined,
});

const server = app.listen(port, () => {
  console.log(`scraping-bot-mcp ${VERSION} (http) listening on port ${port}`);
});

// Deploys: finish the requests in progress (social media waits up to a minute)
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 70_000).unref();
});
