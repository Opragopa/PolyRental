import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mockTelegramEnvExtended } from "telegram-mock-init-data";

const token = "123:local-qa-only";
const url = "http://127.0.0.1:8001/api/miniapp/me";
const results = [];
async function generate(options = {}) {
  const launch = await mockTelegramEnvExtended({ botToken: token, user: {id:42, first_name:"Alice"}, ...options });
  const raw = new URLSearchParams(launch).get("tgWebAppData");
  assert.ok(raw, "Library must return tgWebAppData");
  return raw;
}
async function check(name, raw, expected) {
  const response = await fetch(url, {headers: {"X-Telegram-Init-Data": raw}});
  const body = await response.json();
  assert.equal(response.status, expected, `${name}: ${JSON.stringify(body)}`);
  if (expected === 200) assert.equal(body.id, 42);
  results.push({name, status:response.status, result:"PASS"});
}

await check("valid telegram-mock-init-data signature", await generate(), 200);
// This library has no authDate option: freeze its clock during generation so
// the expired timestamp is signed, instead of invalidating the HMAC afterwards.
const originalNow = Date.now;
let expired;
try { Date.now = () => originalNow() - 90000 * 1000; expired = await generate(); }
finally { Date.now = originalNow; }
await check("expired but correctly signed initData", expired, 401);
const tampered = new URLSearchParams(await generate());
tampered.set("user", JSON.stringify({id:43, first_name:"Bob"}));
await check("user changed after signing", tampered.toString(), 401);
await check("signature by another bot", await generate({botToken:"321:other-qa-bot"}), 401);
await check("anonymous", "", 401);
mkdirSync("artifacts", {recursive:true});
writeFileSync("artifacts/init-data-results.json", JSON.stringify({tool:"telegram-mock-init-data@0.1.0", results}, null, 2));
console.log(JSON.stringify(results, null, 2));
