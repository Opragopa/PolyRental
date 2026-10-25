import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const base = "http://127.0.0.1:1234";
const results = [];
async function api(path, method = "GET", body) {
  const response = await fetch(base + path, {method, headers: {"Content-Type":"application/json"}, body: body ? JSON.stringify(body) : undefined});
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
for (const [profile, id] of [["channel_inline",42],["attachment_menu_channel",43]]) {
  await api("/api/profiles/active", "POST", {name:profile});
  const {initData, initDataUnsafe} = await api("/api/init-data");
  const fields = new URLSearchParams(initData);
  assert.equal(JSON.parse(fields.get("user")).id, id);
  if (profile === "channel_inline") {
    assert.equal(fields.get("start_param"), "channel_id=QA_CHANNEL");
    assert.equal(fields.get("chat_type"), "channel");
    assert.equal(fields.has("chat"), false);
  } else {
    assert.equal(JSON.parse(fields.get("chat")).id, -1009876543210);
  }
  const response = await fetch("http://127.0.0.1:8001/api/miniapp/me", {headers:{"X-Telegram-Init-Data":initData}});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, id);
  results.push({profile,id,status:200,launchFields:[...fields.keys()],result:"PASS"});
}
await api("/api/profiles/active", "POST", {name:"channel_inline"});
const {profile} = await api("/api/profile");
await api("/api/profile", "PATCH", {...profile, theme:"dark"});
mkdirSync("artifacts", {recursive:true});
writeFileSync("artifacts/emulator-results.json", JSON.stringify({tool:"tg-mini-app-emulator@0.1.1",results},null,2));
console.log(JSON.stringify(results,null,2));
