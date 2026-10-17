// Thin client for the ScrapingBot API (https://www.scraping-bot.io/documentation).

export const DEFAULT_API_BASE = "https://api.scraping-bot.io";
export const VERSION = "1.0.0";

// The API gateway closes requests after 60 s; stop waiting a little later.
const REQUEST_TIMEOUT_MS = 90_000;

export interface ApiResult {
  ok: boolean;
  status: number;
  // Parsed JSON when the response is JSON, otherwise the raw text (HTML).
  body: unknown;
  text: string;
}

export interface ApiClient {
  post(path: string, body: unknown): Promise<ApiResult>;
  get(path: string, query: Record<string, string>): Promise<ApiResult>;
}

export function createClient({
  username,
  apiKey,
  baseUrl = DEFAULT_API_BASE,
  fetchImpl = fetch,
}: {
  username: string;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): ApiClient {
  const headers = {
    Authorization: "Basic " + Buffer.from(`${username}:${apiKey}`).toString("base64"),
    Accept: "application/json",
    "User-Agent": `scraping-bot-mcp/${VERSION}`,
  };

  async function send(url: string, init: RequestInit): Promise<ApiResult> {
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown = text;
    if ((response.headers.get("content-type") ?? "").includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        // keep the raw text
      }
    }
    return { ok: response.ok, status: response.status, body, text };
  }

  return {
    post(path, body) {
      return send(baseUrl + path, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    get(path, query) {
      return send(`${baseUrl}${path}?${new URLSearchParams(query)}`, { method: "GET", headers });
    },
  };
}

// The API returns errors as { error: "..." } or
// { error: { code, message, details, suggestedUrl } }; a scrape can also
// answer HTTP 200 with an "error" field.
export function errorMessage(result: ApiResult): string | null {
  const body = result.body as { error?: unknown } | null;
  const error = body && typeof body === "object" ? body.error : undefined;
  if (error && typeof error === "object") {
    const { message, details, suggestedUrl } = error as Record<string, unknown>;
    return [message, details, typeof suggestedUrl === "string" ? `Suggested URL: ${suggestedUrl}` : null]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(" ");
  }
  if (typeof error === "string" && error !== "") return error;
  if (!result.ok) {
    return `HTTP ${result.status}: ${result.text.replace(/\s+/g, " ").slice(0, 300)}`;
  }
  return null;
}
