/* Имитатор прокси превью: режет тело запроса.
   node proxy-sim.js <порт> <порт-приложения> <лимит-байт> [reset|json|strip]
     reset — обрывать соединение вместо ответа 413 (часть прокси так и делает)
     json  — отвечать 413 JSON-ом
     strip — срезать кастомные x- заголовки                              */
const http = require('http');

const [, , P_PORT, A_PORT, LIMIT, MODE] = process.argv;
const PORT = Number(P_PORT || 4174);
const APP = Number(A_PORT || 4173);
const CAP = Number(LIMIT || 524288);
const reset = (MODE || '').includes('reset');
const asJson = (MODE || '').includes('json');
const strip = (MODE || '').includes('strip');

const server = http.createServer((creq, cres) => {
  const headers = { ...creq.headers };
  if (strip) {
    for (const k of Object.keys(headers)) if (k.startsWith('x-')) delete headers[k];
  }
  const opts = { host: '127.0.0.1', port: APP, path: creq.url, method: creq.method, headers };
  const preq = http.request(opts, (pres) => {
    if (cres.writableEnded) return;
    cres.writeHead(pres.statusCode, pres.headers);
    pres.pipe(cres);
  });
  preq.on('error', () => {
    // ответ уже ушёл или соединение убито — вторым ответом ничего не сломаем
    if (cres.writableEnded || cres.headersSent) return;
    try { cres.writeHead(502); cres.end('bad gateway'); } catch (_) {}
  });

  let got = 0;
  let killed = false;
  creq.on('data', (c) => {
    got += c.length;
    if (!killed && got > CAP) {
      killed = true;
      if (reset) {
        // некоторые прокси просто рвут соединение, не успев ответить
        cres.destroy();
      } else {
        try {
          if (asJson) {
            cres.writeHead(413, { 'Content-Type': 'application/json' });
            cres.end(JSON.stringify({ error: 'слишком большой запрос' }));
          } else {
            cres.writeHead(413, { 'Content-Type': 'text/plain' });
            cres.end('413 Request Entity Too Large\n');
          }
        } catch (_) {}
      }
      preq.destroy();
      creq.destroy();
      return;
    }
    if (!killed) preq.write(c);
  });
  creq.on('end', () => { if (!killed) preq.end(); });
  creq.on('aborted', () => { killed = true; preq.destroy(); });
  cres.on('error', () => {});
});

server.on('clientError', (e, sock) => { try { sock.destroy(); } catch (_) {} });
server.listen(PORT, '0.0.0.0', () => {
  console.log(`прокси-имитатор → :${PORT} → :${APP} · лимит тела ${CAP} байт` +
              (reset ? ' · обрыв соединения' : asJson ? ' · 413 JSON' : ' · 413 text') +
              (strip ? ' · x- заголовки срезаются' : ''));
});
