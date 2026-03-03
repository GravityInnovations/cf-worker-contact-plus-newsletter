#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const [, , siteKeyArg, configPathArg, ...extraArgs] = process.argv;

if (!siteKeyArg || !configPathArg) {
  fail("Usage: node scripts/seed-site-config.mjs <siteKey> <config.json> [--remote]");
}

const siteKey = siteKeyArg.trim();
if (!siteKey) {
  fail("siteKey must be a non-empty string");
}

const configPath = resolve(process.cwd(), configPathArg);
let configJson;
try {
  const raw = readFileSync(configPath, "utf8");
  configJson = JSON.parse(raw);
} catch (error) {
  fail(`Failed reading/parsing JSON config at ${configPath}: ${error.message}`);
}

if (typeof configJson !== "object" || configJson === null || Array.isArray(configJson)) {
  fail("Config file must contain a JSON object");
}

const kvKey = `site:${siteKey}`;
const args = ["kv:key", "put", "--binding", "SITE_CONFIG", kvKey, "--path", configPath, ...extraArgs];

console.log(`Writing ${kvKey} to KV binding SITE_CONFIG from ${configPath}`);
const result = spawnSync("wrangler", args, { stdio: "inherit", shell: process.platform === "win32" });

if (result.error) {
  fail(`Failed to run wrangler: ${result.error.message}`);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

console.log("Done.");
