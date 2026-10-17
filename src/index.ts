#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, DEFAULT_API_BASE, VERSION } from "./api.js";
import { registerTools } from "./tools.js";

const username = process.env.SCRAPING_BOT_USERNAME;
const apiKey = process.env.SCRAPING_BOT_API_KEY;

if (!username || !apiKey) {
  process.stderr.write(
    "scraping-bot-mcp: set SCRAPING_BOT_USERNAME and SCRAPING_BOT_API_KEY.\n" +
      "Create an account and find your API key at https://www.scraping-bot.io\n",
  );
  process.exit(1);
}

const server = new McpServer({ name: "scraping-bot", version: VERSION });
registerTools(
  server,
  createClient({ username, apiKey, baseUrl: process.env.SCRAPING_BOT_API_URL || DEFAULT_API_BASE }),
);
await server.connect(new StdioServerTransport());
