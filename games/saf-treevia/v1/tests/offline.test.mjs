import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(testDir, "../..");
const release = "20260927offline";
const serviceWorker = fs.readFileSync(path.join(gameRoot, "service-worker.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(gameRoot, "manifest.webmanifest"), "utf8"));
const app = fs.readFileSync(path.join(gameRoot, "v1", "app.mjs"), "utf8");
const html = fs.readFileSync(path.join(gameRoot, "v1", "index.html"), "utf8");

test("offline app manifest has an installable identity and complete icon set", () => {
  assert.equal(manifest.id, "/games/saf-treevia/");
  assert.equal(manifest.start_url, "./?source=pwa");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons.filter((icon) => icon.type === "image/png").map((icon) => icon.sizes), ["192x192", "512x512"]);
  for (const icon of manifest.icons) {
    assert.equal(fs.existsSync(path.resolve(gameRoot, icon.src)), true, icon.src);
  }
});

test("offline cache includes the encrypted bank and every game runtime dependency", () => {
  for (const asset of [
    "manifest.webmanifest",
    "treevia-192.png",
    "treevia-512.png",
    "v1/index.html",
    "v1/styles.css",
    "v1/app.mjs",
    "v1/answer-utils.mjs",
    "v1/round-utils.mjs",
    "v1/questions.enc.json",
  ]) {
    assert.match(serviceWorker, new RegExp(asset.replaceAll(".", "\\.")));
  }
  assert.match(serviceWorker, /CACHE_OFFLINE/);
  assert.match(serviceWorker, /GET_OFFLINE_STATUS/);
  assert.doesNotMatch(serviceWorker, /TREEVIA_PASSWORD|passwordInput|password-input/);
});

test("page, app, and service worker share one offline release version", () => {
  assert.match(serviceWorker, new RegExp(release));
  assert.match(app, new RegExp(release));
  assert.match(html, new RegExp(release));
  assert.match(html, /rel="manifest"/);
  assert.match(html, /id="offline-save-button"/);
  assert.match(html, /id="offline-status"[^>]*aria-live="polite"/);
});
