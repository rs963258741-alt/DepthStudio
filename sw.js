/* Depth Studio V8.9 — stream an OPFS MP4 to the browser download manager. */
'use strict';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  const scopePath = new URL(self.registration.scope).pathname;
  const downloadPath = new URL('__depthstudio_download__', self.registration.scope).pathname;
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname !== downloadPath) return;

  // Keep this worker alive until the browser has consumed the complete stream.
  let releaseWorker;
  const workerLifetime = new Promise(resolve => { releaseWorker = resolve; });
  event.waitUntil(workerLifetime);

  event.respondWith((async () => {
    try {
      if (!self.navigator?.storage || typeof self.navigator.storage.getDirectory !== 'function') {
        throw new Error('此瀏覽器的背景檔案儲存功能不可用。');
      }
      const storedName = requestUrl.searchParams.get('file') || '';
      const downloadName = requestUrl.searchParams.get('name') || 'DepthStudio_Export.mp4';
      if (!storedName || /[\\/\0]/.test(storedName) || storedName === '.' || storedName === '..') {
        throw new Error('下載檔案名稱無效。');
      }
      const root = await self.navigator.storage.getDirectory();
      const handle = await root.getFileHandle(storedName);
      const file = await handle.getFile();
      if (!file || file.size < 1024) throw new Error('找不到完整的 MP4 檔案。');

      // Use OPFS File.stream() directly. Do not convert the file into a Blob,
      // ArrayBuffer, or a postMessage payload in the Service Worker.
      const bridge = new TransformStream();
      const pumping = file.stream().pipeTo(bridge.writable);
      pumping.then(releaseWorker, releaseWorker);

      const asciiName = downloadName
        .replace(/[\r\n"\\;]/g, '_')
        .replace(/[^\x20-\x7E]/g, '_') || 'DepthStudio_Export.mp4';
      const encodedName = encodeURIComponent(downloadName).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
      const headers = new Headers({
        'Content-Type': 'video/mp4',
        'Content-Length': String(file.size),
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      return new Response(bridge.readable, { status: 200, headers });
    } catch (error) {
      releaseWorker();
      return new Response('Depth Studio 下載失敗：' + (error?.message || String(error)), {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
  })());
});
