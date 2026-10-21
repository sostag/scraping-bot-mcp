import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ApiClient, type ApiResult, errorMessage } from "./api.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// Raw HTML can be several MB: keep the agent's context usable.
const DEFAULT_MAX_HTML_CHARS = 100_000;
// How long scrape_social_media waits for the result before handing back the
// responseId (MCP clients cut long tool calls).
const DEFAULT_SOCIAL_WAIT_MS = 50_000;
const SOCIAL_POLL_INTERVAL_MS = 5_000;

const COST_NOTE =
  "Costs 1 credit, 5 with useChrome, 10 with premiumProxy, 25 with both (and for Google pages); failed requests are refunded. A request blocked by the site is retried once with a premium proxy, billed at the premium price only if it succeeds (the result then says so).";

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Error or JSON result of a scrape.
function toolResult(result: ApiResult): ToolResult {
  const error = errorMessage(result);
  if (error) {
    // Partial data can help the agent understand the failure.
    const data = (result.body as { data?: unknown } | null)?.data;
    return text(`ScrapingBot error: ${error}${data ? `\n\nReturned data:\n${json(data)}` : ""}`, true);
  }
  return text(typeof result.body === "string" ? result.body : json(result.body));
}

const pageOptions = {
  url: z.string().describe("Full URL of the page, starting with https://"),
  useChrome: z.boolean().optional().describe("Render the page with a headless Chrome (JavaScript sites). Default false."),
  premiumProxy: z.boolean().optional().describe("Use a premium proxy for sites that block regular proxies. Default false."),
  proxyCountry: z
    .string()
    .length(2)
    .optional()
    .describe("Two-letter country code of the proxy (requires premiumProxy), e.g. FR, US."),
  premiumFallback: z
    .boolean()
    .optional()
    .describe(
      "When the site blocks the request, retry it once with a premium proxy, billed at the premium price only if it succeeds. Default true; false turns it off.",
    ),
};

type PageArgs = {
  url: string;
  useChrome?: boolean;
  premiumProxy?: boolean;
  proxyCountry?: string;
  premiumFallback?: boolean;
};

function scrapeOptions({ useChrome, premiumProxy, proxyCountry, premiumFallback }: PageArgs) {
  return {
    ...(useChrome !== undefined && { useChrome }),
    ...(premiumProxy !== undefined && { premiumProxy }),
    ...(proxyCountry && { proxyCountry: proxyCountry.toUpperCase() }),
    ...(premiumFallback !== undefined && { premiumFallback }),
  };
}

// Structured scrapers: same request, different extractor.
const STRUCTURED_TOOLS = [
  {
    name: "scrape_retail",
    path: "/scrape/retail",
    title: "Scrape a product page",
    description:
      "Extract structured product data (title, price, currency, images, brand, stock, EAN...) from an e-commerce product page such as Amazon, Cdiscount, Fnac or Zalando.",
  },
  {
    name: "scrape_real_estate",
    path: "/scrape/real-estate",
    title: "Scrape a real estate listing",
    description:
      "Extract a property listing (price or rent, surface, rooms, bedrooms, location, images...) from real estate sites such as SeLoger, Leboncoin, Rightmove or Zillow.",
  },
  {
    name: "scrape_booking",
    path: "/scrape/booking",
    title: "Scrape a travel page",
    description:
      "Extract a hotel or rental page (title, price, images, rating, rooms) or a search results page from Booking.com, Airbnb, Expedia, Hotels.com or Abritel. Put the stay dates in the URL.",
  },
  {
    name: "scrape_grocery",
    path: "/scrape/grocery",
    title: "Scrape a grocery product",
    description: "Extract a grocery product page (title, price, image, brand, nutritional values).",
  },
] as const;

// Social Media scrapers and the inputs they take.
const SOCIAL_SCRAPERS = {
  instagramProfile: "account (name or profile URL); returns the 12 latest posts",
  instagramPost: "url",
  tiktokProfile: "url",
  tiktokHashtag: "hashtag; max_video_count",
  facebookProfile: "url; load_more_items_count",
  facebookPost: "url",
  facebookOrganization: "url",
  facebookMarketplaceItem: "url; country",
  facebookMarketplaceSearch: "keyword, city, country; items_limit",
  linkedinProfile: "url; language",
  linkedinCompanyProfile: "url; language",
  linkedinPost: "url",
  linkedinSearchResult: "keywords; page, language",
  twitterProfile: "url; number_of_tweets",
  twitterSearch: "search; posts_max_count",
  threadsProfile: "url",
  threadsPost: "url",
} as const;

type SocialScraper = keyof typeof SOCIAL_SCRAPERS;
const socialScraperNames = Object.keys(SOCIAL_SCRAPERS) as [SocialScraper, ...SocialScraper[]];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 202 { status: "pending" }, or the error answered to a check made too soon.
function isPending(result: ApiResult): boolean {
  if (result.status === 202) return true;
  return /please wait at least a second/i.test(errorMessage(result) ?? "");
}

export function registerTools(
  server: McpServer,
  client: ApiClient,
  { socialWaitMs = DEFAULT_SOCIAL_WAIT_MS, pollIntervalMs = SOCIAL_POLL_INTERVAL_MS } = {},
) {
  server.registerTool(
    "scrape_raw_html",
    {
      title: "Get the HTML of a page",
      description: `Fetch the HTML source of any public web page through ScrapingBot's proxies. Use useChrome for pages built with JavaScript. ${COST_NOTE}`,
      inputSchema: {
        ...pageOptions,
        waitForNetworkRequests: z
          .boolean()
          .optional()
          .describe("With useChrome, wait for the page's network requests to finish. Default false."),
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum number of characters returned. Default ${DEFAULT_MAX_HTML_CHARS}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const options = {
        ...scrapeOptions(args),
        ...(args.waitForNetworkRequests !== undefined && { waitForNetworkRequests: args.waitForNetworkRequests }),
      };
      const result = await client.post("/scrape/raw-html", { url: args.url, options });
      const error = typeof result.body === "string" && result.ok ? null : errorMessage(result);
      if (error) return text(`ScrapingBot error: ${error}`, true);
      const html = result.text;
      const max = args.maxChars ?? DEFAULT_MAX_HTML_CHARS;
      const page =
        html.length > max
          ? `${html.slice(0, max)}\n\n[Truncated: ${html.length} characters in total. Raise maxChars to get more.]`
          : html;
      // Retried with a premium proxy: the agent learns the price and how to skip the first attempt
      return text(result.notice ? `[Note: ${result.notice}]\n\n${page}` : page);
    },
  );

  for (const tool of STRUCTURED_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: `${tool.description} Returns JSON. ${COST_NOTE}`,
        inputSchema: pageOptions,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args) => toolResult(await client.post(tool.path, { url: args.url, options: scrapeOptions(args) })),
    );
  }

  server.registerTool(
    "scrape_search_engine",
    {
      title: "Search Google or Bing",
      description:
        "Get search engine results (organic results, related searches, people also ask...) as JSON. Costs 30 credits; failed requests are refunded.",
      inputSchema: {
        search: z.string().min(1).describe("The search query"),
        engine: z.enum(["google", "bing"]).optional().describe("Default google"),
        searchType: z
          .enum(["search", "maps", "trends"])
          .optional()
          .describe("Google only: search (default), maps or trends"),
        domainCountry: z.string().length(2).optional().describe("Two-letter country of the results, e.g. US (default), FR"),
        resultLang: z.string().min(2).optional().describe("Language of the results, e.g. en (default), fr"),
        page: z.number().int().min(1).optional().describe("Result page, default 1"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ search, engine = "google", searchType = "search", domainCountry = "US", resultLang = "en", page }) =>
      toolResult(
        await client.post("/scrape/search-engine", {
          engine,
          search,
          searchType: engine === "google" ? searchType : "search",
          format: "json",
          domainCountry: domainCountry.toUpperCase(),
          resultLang,
          ...(page !== undefined && { page }),
        }),
      ),
  );

  async function pollSocial(scraper: string, responseId: string, waitMs: number): Promise<ToolResult> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      // The API refuses a check less than a second after the request.
      await sleep(pollIntervalMs);
      const result = await client.get("/scrape/data-scraper-response", { scraper, responseId });
      if (!isPending(result)) return toolResult(result);
      if (Date.now() + pollIntervalMs > deadline) {
        return text(
          json({
            status: "pending",
            scraper,
            responseId,
            message:
              "The result is not ready yet (Social Media scrapes take from a few seconds to several minutes). Call get_social_media_result with this scraper and responseId later; waiting costs no credit.",
          }),
        );
      }
    }
  }

  server.registerTool(
    "scrape_social_media",
    {
      title: "Scrape a social media page",
      description:
        "Scrape a public social media profile, post or search (Instagram, TikTok, Facebook, LinkedIn, X/Twitter, Threads). " +
        "Choose the scraper and give its inputs: " +
        Object.entries(SOCIAL_SCRAPERS)
          .map(([name, inputs]) => `${name} (${inputs})`)
          .join(", ") +
        ". Waits for the result for about a minute, otherwise returns a responseId for get_social_media_result. Costs 30 credits; failed requests are refunded.",
      inputSchema: {
        scraper: z.enum(socialScraperNames),
        url: z.string().optional().describe("Profile, post or page URL"),
        account: z.string().optional().describe("instagramProfile: account name or profile URL"),
        hashtag: z.string().optional(),
        keyword: z.string().optional().describe("facebookMarketplaceSearch"),
        keywords: z.string().optional().describe("linkedinSearchResult"),
        search: z.string().optional().describe("twitterSearch"),
        city: z.string().optional(),
        country: z.string().optional(),
        language: z.string().optional(),
        page: z.string().optional(),
        number_of_tweets: z.number().int().positive().optional(),
        max_video_count: z.number().int().positive().optional(),
        load_more_items_count: z.number().int().positive().optional(),
        items_limit: z.number().int().positive().optional(),
        posts_max_count: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ scraper, ...inputs }) => {
      const params = Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== undefined));
      const queued = await client.post("/scrape/data-scraper", { scraper, ...params });
      const error = errorMessage(queued);
      const responseId = (queued.body as { responseId?: unknown } | null)?.responseId;
      if (error || typeof responseId !== "string") {
        return text(`ScrapingBot error: ${error ?? `no responseId in ${queued.text.slice(0, 300)}`}`, true);
      }
      return pollSocial(scraper, responseId, socialWaitMs);
    },
  );

  server.registerTool(
    "get_social_media_result",
    {
      title: "Get a pending social media result",
      description:
        "Get the result of a scrape_social_media request that was still pending, from its scraper and responseId. Waits about a minute. Costs no credit.",
      inputSchema: {
        scraper: z.enum(socialScraperNames),
        responseId: z.string().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ scraper, responseId }) => pollSocial(scraper, responseId, socialWaitMs),
  );
}
