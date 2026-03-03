import type { KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  SITE_CONFIG: KVNamespace;
}

interface SiteBrevoConfig {
  apiKey: string;
  listId: number;
}

interface SiteBasinConfig {
  endpoint?: string;
}

interface SiteConfig {
  enabled: boolean;
  allowedOrigins: string[];
  brevo?: SiteBrevoConfig;
  basin?: SiteBasinConfig;
}

interface JsonRecord {
  [key: string]: unknown;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const CORS_ALLOWED_METHODS = "POST, OPTIONS";
const CORS_ALLOWED_HEADERS = "content-type, x-site-key";
const API_ROUTES = new Set(["/api/subscribe", "/api/contact"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!API_ROUTES.has(url.pathname)) {
      return jsonResponse(
        { ok: false, error: "Not found" },
        { status: 404 }
      );
    }

    const siteKey = getSiteKey(request);
    if (!siteKey) {
      return jsonResponse(
        { ok: false, error: "Missing siteKey" },
        { status: 400 }
      );
    }

    const config = await loadConfig(env, siteKey);
    if (!config || config.enabled !== true) {
      return jsonResponse(
        { ok: false, error: "Site not available" },
        { status: 404 }
      );
    }

    const origin = request.headers.get("Origin");
    if (origin && !isOriginAllowed(origin, config)) {
      return jsonResponse(
        { ok: false, error: "Origin not allowed" },
        { status: 403, origin, config }
      );
    }

    if (request.method === "OPTIONS") {
      return handlePreflight(origin, config);
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: "Method not allowed" },
        { status: 405, origin, config }
      );
    }

    if (url.pathname === "/api/subscribe") {
      return handleSubscribe(request, config, origin);
    }

    if (url.pathname === "/api/contact") {
      return handleContact(request, origin, config);
    }

    return jsonResponse(
      { ok: false, error: "Not found" },
      { status: 404, origin, config }
    );
  },
};

function getSiteKey(request: Request): string | null {
  const fromHeader = request.headers.get("x-site-key")?.trim();
  if (fromHeader) {
    return fromHeader;
  }

  const fromQuery = new URL(request.url).searchParams.get("siteKey")?.trim();
  if (fromQuery) {
    return fromQuery;
  }

  return null;
}

async function loadConfig(env: Env, siteKey: string): Promise<SiteConfig | null> {
  const key = `site:${siteKey}`;
  const raw = await env.SITE_CONFIG.get(key, "json");
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const config = raw as Partial<SiteConfig>;
  if (typeof config.enabled !== "boolean") {
    return null;
  }

  const allowedOrigins = Array.isArray(config.allowedOrigins)
    ? config.allowedOrigins.filter((value): value is string => typeof value === "string")
    : [];

  return {
    enabled: config.enabled,
    allowedOrigins,
    brevo: config.brevo,
    basin: config.basin,
  };
}

function isOriginAllowed(origin: string, config: SiteConfig): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  for (const allowed of config.allowedOrigins) {
    const normalizedAllowed = normalizeOrigin(allowed);
    if (normalizedAllowed && normalizedAllowed === normalizedOrigin) {
      return true;
    }
  }

  return false;
}

function corsHeaders(origin: string | null, config?: SiteConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
  };

  if (origin && config && isOriginAllowed(origin, config)) {
    headers["Access-Control-Allow-Origin"] = normalizeOrigin(origin) ?? origin;
  }

  return headers;
}

function jsonResponse(
  payload: JsonRecord,
  options: {
    status?: number;
    origin?: string | null;
    config?: SiteConfig;
  } = {}
): Response {
  const headers = {
    ...JSON_HEADERS,
    ...corsHeaders(options.origin ?? null, options.config),
  };

  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers,
  });
}

function handlePreflight(origin: string | null, config: SiteConfig): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin, config),
  });
}

async function handleSubscribe(
  request: Request,
  config: SiteConfig,
  origin: string | null
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) {
    return jsonResponse(
      { ok: false, error: "Invalid JSON body" },
      { status: 400, origin, config }
    );
  }

  if (isHoneypotTriggered(body)) {
    return jsonResponse({ ok: true }, { status: 200, origin, config });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!isValidEmail(email)) {
    return jsonResponse(
      { ok: false, error: "Invalid email" },
      { status: 400, origin, config }
    );
  }

  const attributes =
    body.attributes && isPlainObject(body.attributes)
      ? (body.attributes as JsonRecord)
      : undefined;

  if (!config.brevo?.apiKey || typeof config.brevo.listId !== "number") {
    return jsonResponse(
      { ok: false, error: "Site provider not configured" },
      { status: 500, origin, config }
    );
  }

  const brevoPayload: JsonRecord = {
    email,
    updateEnabled: true,
    listIds: [config.brevo.listId],
  };

  if (attributes) {
    brevoPayload.attributes = attributes;
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": config.brevo.apiKey,
      },
      body: JSON.stringify(brevoPayload),
    });
  } catch (error) {
    console.error("Brevo request failed", toLoggableError(error));
    return jsonResponse(
      { ok: false, error: "Upstream provider unavailable" },
      { status: 502, origin, config }
    );
  }

  if (upstreamResponse.ok) {
    return jsonResponse({ ok: true }, { status: 200, origin, config });
  }

  const upstreamBody = await safeReadText(upstreamResponse);
  if (isAlreadyExistsStyleError(upstreamResponse.status, upstreamBody)) {
    return jsonResponse({ ok: true }, { status: 200, origin, config });
  }

  console.error("Brevo provider error", {
    status: upstreamResponse.status,
    body: sanitizeLogText(upstreamBody),
  });

  return jsonResponse(
    { ok: false, error: "Subscription provider error" },
    { status: 502, origin, config }
  );
}

async function handleContact(
  request: Request,
  origin: string | null,
  config: SiteConfig
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) {
    return jsonResponse(
      { ok: false, error: "Invalid JSON body" },
      { status: 400, origin, config }
    );
  }

  if (isHoneypotTriggered(body)) {
    return jsonResponse({ ok: true }, { status: 200, origin, config });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return jsonResponse(
      { ok: false, error: "Message is required" },
      { status: 400, origin, config }
    );
  }

  return jsonResponse(
    { ok: false, error: "Not implemented yet" },
    { status: 501, origin, config }
  );
}

async function readJsonBody(request: Request): Promise<JsonRecord | null> {
  try {
    const parsed = await request.json();
    return isPlainObject(parsed) ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidEmail(email: string): boolean {
  if (email.length < 3 || email.length > 320) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isHoneypotTriggered(body: JsonRecord): boolean {
  const website = body.website;
  return typeof website === "string" && website.trim().length > 0;
}

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function isAlreadyExistsStyleError(status: number, body: string): boolean {
  if (status !== 400 && status !== 409) {
    return false;
  }

  const lowered = body.toLowerCase();
  return (
    lowered.includes("already") ||
    lowered.includes("exists") ||
    lowered.includes("duplicate")
  );
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function sanitizeLogText(value: string): string {
  if (!value) {
    return "";
  }
  return value.slice(0, 500);
}

function toLoggableError(error: unknown): { message: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: "Unknown error" };
}

/*
Testing examples:

1) OPTIONS preflight (include siteKey as query param for preflight):
curl -i -X OPTIONS "http://127.0.0.1:8787/api/subscribe?siteKey=your-site-key" \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,x-site-key"

2) Subscribe with x-site-key:
curl -i -X POST "http://127.0.0.1:8787/api/subscribe" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -H "x-site-key: your-site-key" \
  --data '{"email":"person@example.com","attributes":{"FIRSTNAME":"Ava"}}'

3) Localhost origin testing via query siteKey:
curl -i -X POST "http://127.0.0.1:8787/api/subscribe?siteKey=your-site-key" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  --data '{"email":"person@example.com"}'
*/

