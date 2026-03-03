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
const SITE_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (!API_ROUTES.has(url.pathname)) {
      return jsonResponse(
        { ok: false, error: "Not found" },
        { status: 404, origin }
      );
    }

    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("Access-Control-Request-Method");
      if (requestedMethod && requestedMethod.toUpperCase() !== "POST") {
        return jsonResponse(
          { ok: false, error: "Method not allowed" },
          { status: 405, origin, publicCors: true }
        );
      }
      return handlePublicPreflight(origin);
    }

    const siteKey = getSiteKey(request);
    if (!siteKey) {
      return jsonResponse(
        { ok: false, error: "Missing siteKey" },
        { status: 400, origin, publicCors: true }
      );
    }
    if (!isValidSiteKey(siteKey)) {
      return jsonResponse(
        { ok: false, error: "Invalid siteKey" },
        { status: 400, origin, publicCors: true }
      );
    }

    const config = await loadConfig(env, siteKey);
    if (!config || config.enabled !== true) {
      return jsonResponse(
        { ok: false, error: "Site not available" },
        { status: 404 }
      );
    }

    if (origin && !isOriginAllowed(origin, config)) {
      return jsonResponse(
        { ok: false, error: "Origin not allowed" },
        { status: 403, origin, config }
      );
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: "Method not allowed" },
        { status: 405, origin, config }
      );
    }
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return jsonResponse(
        { ok: false, error: "Content-Type must be application/json" },
        { status: 415, origin, config }
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
    ? config.allowedOrigins
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeOrigin(value))
        .filter((value): value is string => Boolean(value))
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
    Vary: "Origin, Access-Control-Request-Headers",
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
  };

  if (origin && config && isOriginAllowed(origin, config)) {
    headers["Access-Control-Allow-Origin"] = normalizeOrigin(origin) ?? origin;
  }

  return headers;
}

function publicCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin, Access-Control-Request-Headers",
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
  };

  if (origin) {
    headers["Access-Control-Allow-Origin"] = normalizeOrigin(origin) ?? origin;
  } else {
    headers["Access-Control-Allow-Origin"] = "*";
  }

  return headers;
}

function jsonResponse(
  payload: JsonRecord,
  options: {
    status?: number;
    origin?: string | null;
    config?: SiteConfig;
    publicCors?: boolean;
  } = {}
): Response {
  const origin = options.origin ?? null;
  const cors = options.publicCors
    ? publicCorsHeaders(origin)
    : corsHeaders(origin, options.config);
  const headers = { ...JSON_HEADERS, ...cors };

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

function handlePublicPreflight(origin: string | null): Response {
  return new Response(null, {
    status: 204,
    headers: publicCorsHeaders(origin),
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

  const basinEndpoint = getBasinEndpoint(config);
  if (!basinEndpoint) {
    return jsonResponse(
      { ok: false, error: "Site provider not configured" },
      { status: 500, origin, config }
    );
  }

  if (!hasAnyNonEmptyField(body)) {
    return jsonResponse(
      { ok: false, error: "At least one form field is required" },
      { status: 400, origin, config }
    );
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(basinEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error("Basin request failed", toLoggableError(error));
    return jsonResponse(
      { ok: false, error: "Upstream provider unavailable" },
      { status: 502, origin, config }
    );
  }

  if (upstreamResponse.ok) {
    return jsonResponse({ ok: true }, { status: 200, origin, config });
  }

  const upstreamBody = await safeReadText(upstreamResponse);
  console.error("Basin provider error", {
    status: upstreamResponse.status,
    body: sanitizeLogText(upstreamBody),
  });

  return jsonResponse(
    { ok: false, error: "Contact provider error" },
    { status: 502, origin, config }
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

function hasAnyNonEmptyField(body: JsonRecord): boolean {
  for (const value of Object.values(body)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return true;
    }
  }
  return false;
}

function isValidSiteKey(value: string): boolean {
  return SITE_KEY_PATTERN.test(value);
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  return contentType.toLowerCase().includes("application/json");
}

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function getBasinEndpoint(config: SiteConfig): string | null {
  const raw = config.basin?.endpoint?.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
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
