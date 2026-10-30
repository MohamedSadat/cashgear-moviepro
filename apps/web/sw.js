// The web app's service worker: the app works offline once it has loaded online.
// apps/web/pwa.ts builds it with the build's files in place of the two lists below.
//
// - The app shell (the page, scripts, styles, WASM and pack images) is cached when
//   the worker installs, under a name of its build.
// - Other build files (fonts, sounds, stickers, the AI runtime) are cached the first
//   time they are used, and dropped once a build no longer has them.
// - Pages come from the network first, so a new build shows at once, and from the
//   cache offline. Cached responses keep their cross-origin isolation headers.
// - A range request (media) is answered as a 206 slice of the cached file; a file
//   first read in ranges is fetched and cached whole.

/** Cached when the worker installs. */
const shell = self.__SHELL__;
/** Every file of the build, to keep in the cache of files cached on use. */
const files = new Set(self.__FILES__);
const build = self.__BUILD__;
const shellCache = `cgv-shell-${build}`;
const filesCache = 'cgv-files';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(shellCache)
      .then((cache) => cache.addAll(shell))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('cgv-shell-') && name !== shellCache) await caches.delete(name);
      }
      const cache = await caches.open(filesCache);
      for (const request of await cache.keys()) {
        if (!files.has(new URL(request.url).pathname)) await cache.delete(request);
      }
      await self.clients.claim();
    })(),
  );
});

/** A 206 response with the part of `response` that `range` asks for. */
async function slice(response, range) {
  const body = await response.blob();
  const [, from, to] = /bytes=(\d*)-(\d*)/.exec(range) ?? [];
  const start = from === '' ? Math.max(0, body.size - Number(to)) : Number(from);
  const end = from !== '' && to !== '' ? Math.min(Number(to), body.size - 1) : body.size - 1;
  if (!(start <= end)) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${body.size}` },
    });
  }
  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${body.size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}

/** Whole files on their way into the cache, so ranges read together fetch one copy. */
const filling = new Map();

/** Fetches the whole file at `url` and caches it; null when it cannot be had whole. */
function fill(url) {
  let whole = filling.get(url);
  if (!whole) {
    whole = (async () => {
      const response = await fetch(url);
      if (response.status !== 200) return null;
      await (await caches.open(filesCache)).put(url, response.clone());
      return response;
    })().finally(() => filling.delete(url));
    filling.set(url, whole);
  }
  return whole.then((response) => response?.clone() ?? null);
}

async function fromCache(request) {
  const range = request.headers.get('Range');
  const cached = (await caches.match(request.url)) ?? (await fill(request.url).catch(() => null));
  if (cached) return range ? slice(cached, range) : cached;
  return fetch(request);
}

async function page(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await caches.match('/', { cacheName: shellCache });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') event.respondWith(page(request));
  else if (files.has(url.pathname)) event.respondWith(fromCache(request));
});
