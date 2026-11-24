/* Depth Studio V8.11 — pull-driven OPFS download with client-side progress. */
'use strict';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'DEPTHSTUDIO_VERSION_CHECK') {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ type: 'DEPTHSTUDIO_VERSION', version: '8.11' });
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  const downloadPath = new URL('__depthstudio_download__', self.registration.scope).pathname;
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname !== downloadPath) return;

  let releaseWorker;
  let lifetimeReleased = false;
  const workerLifetime = new Promise(resolve => { releaseWorker = resolve; });
  const finishLifetime = () => {
    if (lifetimeReleased) return;
    lifetimeReleased = true;
    releaseWorker();
  };
  event.waitUntil(workerLifetime);

  event.respondWith((async () => {
    let reader = null;
    let bytesSent = 0;
    let totalBytes = 0;
    let downloadId = requestUrl.searchParams.get('id') || '';
    let reportThreshold = 1024 * 1024;
    let nextReportAt = reportThreshold;
    let notifyClients = async () => {};
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
      totalBytes = file.size;

      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const scopeUrl = new URL(self.registration.scope);
      const pageClients = allClients.filter(client => {
        try {
          const clientUrl = new URL(client.url);
          return clientUrl.origin === scopeUrl.origin && clientUrl.pathname.startsWith(scopeUrl.pathname);
        } catch (_) { return false; }
      });
      notifyClients = async (phase, extra = {}) => {
        const payload = {
          type: 'depthstudio-download-progress',
          id: downloadId,
          phase,
          sent: bytesSent,
          total: totalBytes,
          ...extra
        };
        for (const client of pageClients) {
          try { client.postMessage(payload); } catch (_) {}
        }
      };
      await notifyClients('start');
      reader = file.stream().getReader();

      const body = new ReadableStream({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              controller.close();
              await notifyClients('complete');
              finishLifetime();
              return;
            }
            const chunk = result.value;
            bytesSent += chunk.byteLength;
            controller.enqueue(chunk);
            if (bytesSent >= nextReportAt || bytesSent >= totalBytes) {
              await notifyClients('progress');
              nextReportAt = bytesSent + reportThreshold;
            }
          } catch (error) {
            try { controller.error(error); } catch (_) {}
            await notifyClients('error', { message: error?.message || String(error) });
            finishLifetime();
          }
        },
        async cancel(reason) {
          try { await reader?.cancel(reason); } catch (_) {}
          await notifyClients('cancelled', { message: '瀏覽器取消或中斷下載' });
          finishLifetime();
        }
      }, { highWaterMark: 1 });

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
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'none'
      });
      return new Response(body, { status: 200, headers });
    } catch (error) {
      await notifyClients('error', { message: error?.message || String(error) });
      finishLifetime();
      return new Response('Depth Studio 下載失敗：' + (error?.message || String(error)), {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
  })());
});
