const cacheName = "somo-static-v1";
const versionedAsset =
  /^\/assets\/[A-Za-z0-9_-]+[.-][A-Za-z0-9_-]{8,}\.(?:css|js|mjs|woff2|png|webp|svg)$/;

export function shouldCacheRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  return versionedAsset.test(new URL(request.url).pathname);
}

declare const self: ServiceWorkerGlobalScope;

if (typeof self !== "undefined" && "skipWaiting" in self) {
  self.addEventListener("install", (event) => {
    event.waitUntil(self.skipWaiting());
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key !== cacheName)
              .map((key) => caches.delete(key)),
          ),
        )
        .then(() => self.clients.claim()),
    );
  });
  self.addEventListener("fetch", (event) => {
    if (!shouldCacheRequest(event.request)) return;
    event.respondWith(
      caches.open(cacheName).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached !== undefined) return cached;
        const response = await fetch(event.request, { cache: "no-store" });
        if (response.ok && response.type !== "opaque")
          await cache.put(event.request, response.clone());
        return response;
      }),
    );
  });
}
