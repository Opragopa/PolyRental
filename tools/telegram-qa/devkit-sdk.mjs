import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// tma-devkit 0.1.1 signs first, then appends its placeholder signature. Telegram
// HMAC validation (including aiogram) authenticates every field except hash.
// Repair only the locally served mock, keeping the application's verifier intact.
export function devkitSdk() {
  const source = readFileSync(fileURLToPath(import.meta.resolve("tma-devkit")), "utf8");
  const marker = "initDataFields.signature = sigB64;";
  assert.equal(source.split(marker).length, 2, "Review DevKit adapter after upgrading the pinned package");
  return source.replace(marker, `${marker}
    checkKeys.push('signature');
    checkKeys.sort();
    dataCheckString = checkKeys.map(function(key) { return key + '=' + initDataFields[key]; }).join('\\n');
    initDataFields.hash = dkTelegramInitDataHash(dataCheckString, botToken);
  `);
}
