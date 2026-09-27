const RELEASE = "20260927offline";
const CACHE_PREFIX = "saf-treevia-offline-";
const CACHE_NAME = `${CACHE_PREFIX}${RELEASE}`;
const ROOT_URL = new URL("./", self.location.href);

const assetUrl = (relativePath) => new URL(relativePath, ROOT_URL).href;
const OFFLINE_ASSETS = [
  assetUrl("./"),
  assetUrl("./manifest.webmanifest"),
  assetUrl("./icons/treevia-icon.svg"),
  assetUrl("./icons/treevia-192.png"),
  assetUrl("./icons/treevia-512.png"),
  assetUrl("./v1/"),
  assetUrl("./v1/index.html"),
  assetUrl(`./v1/styles.css?v=${RELEASE}`),
  assetUrl(`./v1/app.mjs?v=${RELEASE}`),
  assetUrl(`./v1/answer-utils.mjs?v=${RELEASE}`),
  assetUrl(`./v1/round-utils.mjs?v=${RELEASE}`),
  assetUrl("./v1/questions.enc.json"),
];

async function cacheOfflineAssets() {
  const cache = await caches.open(CACHE_NAME);
  const requests = OFFLINE_ASSETS.map((url) => new Request(url, {
    cache: "reload",
    credentials: "same-origin",
  }));
  await cache.addAll(requests);
  return { ready: true, assetCount: OFFLINE_ASSETS.length, release: RELEASE };
}

async function getOfflineStatus() {
  const cache = await caches.open(CACHE_NAME);
  const matches = await Promise.all(OFFLINE_ASSETS.map((url) => cache.match(url)));
  const assetCount = matches.filter(Boolean).length;
  return {
    ready: assetCount === OFFLINE_ASSETS.length,
    assetCount,
    expectedAssetCount: OFFLINE_ASSETS.length,
    release: RELEASE,
  };
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheOfflineAssets().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const reply = event.ports?.[0];
  if (!reply) return;

  if (event.data?.type === "CACHE_OFFLINE") {
    event.waitUntil(
      cacheOfflineAssets()
        .then((result) => reply.postMessage({ ok: true, ...result }))
        .catch((error) => reply.postMessage({ ok: false, error: error.message })),
    );
    return;
  }

  if (event.data?.type === "GET_OFFLINE_STATUS") {
    event.waitUntil(
      getOfflineStatus()
        .then((result) => reply.postMessage({ ok: true, ...result }))
        .catch((error) => reply.postMessage({ ok: false, error: error.message })),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(ROOT_URL.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      if (request.mode !== "navigate") throw error;
      const fallbackUrl = url.pathname.startsWith(`${ROOT_URL.pathname}v1/`)
        ? assetUrl("./v1/")
        : assetUrl("./");
      return (await cache.match(fallbackUrl, { ignoreSearch: true }))
        ?? new Response("The offline copy is not ready yet.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
    }
  })());
});
