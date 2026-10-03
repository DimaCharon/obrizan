#!/usr/bin/env node
/* Тестовый прогон API НАРЕЗАТОРА */
const { execFileSync } = require('child_process');
const fs = require('fs');
const ff = require('/home/user/app/node_modules/ffmpeg-static');
const fp = require('/home/user/app/node_modules/ffprobe-static').path;

const BASE = 'http://127.0.0.1:4173';
const SRC = '/home/user/testdata/test.mp4';
/* Всё, что тест создал на сервере. Убираем в конце через API — иначе data/
   распухает на десятки мегабайт, а снимок рабочей папки ограничен ~128 МБ и
   вытесняет оттуда загруженное пользователем видео. */
const made = { uploads: [], jobs: [] };

function j(method, path, body) {
  return fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
}

(async () => {
  console.log('— план');
  const p = await j('POST', '/api/plan', { fileId: 'x', pieces: 8, overlap: 1.5 });
  console.log('  plan без файла →', p.status, p.data.error);

  console.log('— список задач (пусто)');
  console.log('  ', (await j('GET', '/api/jobs')).data.jobs.length, 'задач');

  const up = await fetch(BASE + '/api/uploads', {
    method: 'POST',
    body: (() => {
      const fd = new FormData();
      fd.append('video', new Blob([fs.readFileSync(SRC)]), 'test.mp4');
      return fd;
    })(),
  });
  const meta = await up.json();
  console.log('— загрузка →', up.status, JSON.stringify({
    name: meta.name, duration: meta.duration, w: meta.width, h: meta.height,
    fps: meta.fps, v: meta.videoCodec, a: meta.audioCodec, size: meta.size,
  }));

  made.uploads.push(meta.fileId);
  const plan = await j('POST', '/api/plan', { fileId: meta.fileId, pieces: 8, overlap: 1.5 });
  console.log('— план →', plan.status, plan.data.plan.length, 'кусков');
  plan.data.plan.forEach((s) => console.log(`   #${s.index + 1} ${s.start.toFixed(2)} → ${s.end.toFixed(2)} (${s.duration.toFixed(2)}с)`));

  console.log('— нарезка');
  const cut = await j('POST', '/api/cut', { fileId: meta.fileId, pieces: 8, overlap: 1.5, mode: 'accurate' });
  console.log('  cut →', cut.status, cut.data.job && cut.data.job.id, 'container:', cut.data.job && cut.data.job.container);
  const jobId = cut.data.job.id;
  made.jobs.push(jobId);

  let job;
  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    job = (await j('GET', '/api/jobs/' + jobId)).data.job;
    if (job.status === 'done' || job.status === 'error') break;
  }
  console.log('  статус:', job.status, 'прогресс:', job.progress.toFixed(2), 'ошибка:', job.error);
  job.results.forEach((r) => console.log(`   ${r.status.padEnd(7)} ${r.name} ${r.size}Б`));

  console.log('— проверка длительностей через ffprobe');
  for (const r of job.results) {
    const f = `/home/user/app/data/jobs/${jobId}/pieces/${r.file}`;
    try {
      const out = execFileSync(fp, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();
      console.log(`   ${r.name} → ${Number(out).toFixed(2)}с (ожидали ${r.duration.toFixed(2)}с)`);
    } catch (e) { console.log('   ошибка', r.name, e.message); }
  }

  console.log('— thumbnails');
  const thumbs = fs.readdirSync(`/home/user/app/data/jobs/${jobId}/thumbs`);
  console.log('  ', thumbs.join(', '));

  console.log('— одиночное скачивание');
  const dl = await fetch(`${BASE}/api/download/${jobId}/0`);
  console.log('  ', dl.status, dl.headers.get('content-disposition'), dl.headers.get('content-type'), (await dl.arrayBuffer()).byteLength, 'байт');

  console.log('— zip');
  const zipPath = '/home/user/testdata/out.zip';
  const zr = await fetch(`${BASE}/api/jobs/${jobId}/zip`);
  fs.writeFileSync(zipPath, Buffer.from(await zr.arrayBuffer()));
  console.log('  ', zr.status, zr.headers.get('content-disposition'), fs.statSync(zipPath).size, 'байт');
  console.log('  содержимое:', execFileSync('unzip', ['-l', zipPath]).toString().trim().split('\n').slice(-3).join(' | '));

  console.log('— быстрый режим');
  const cut2 = await j('POST', '/api/cut', { fileId: meta.fileId, pieces: 5, overlap: 2, mode: 'fast' });
  made.jobs.push(cut2.data.job.id);
  const j2 = cut2.data.job;
  let job2;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 700));
    job2 = (await j('GET', '/api/jobs/' + j2.id)).data.job;
    if (job2.status === 'done' || job2.status === 'error') break;
  }
  console.log('  статус:', job2.status, 'контейнер:', job2.container, 'файлы:', job2.results.map((r) => `${r.file}:${r.status}`).join(', '));

  console.log('— валидация');
  console.log('  1 кусок →', (await j('POST', '/api/plan', { fileId: meta.fileId, pieces: 1, overlap: 1 })).status);
  console.log('  200 кусков →', (await j('POST', '/api/plan', { fileId: meta.fileId, pieces: 200, overlap: 1 })).status);
  console.log('  90 кусков (по 1с) →', (await j('POST', '/api/plan', { fileId: meta.fileId, pieces: 90, overlap: 1 })).status);

  console.log('— удаление');
  console.log('  ', (await j('DELETE', '/api/jobs/' + job2.id)).status, (await j('DELETE', '/api/uploads/' + meta.fileId)).status);

  /* ── чанковая загрузка ─────────────────────────────────────── */
  console.log('— чанковая загрузка');

  async function chunked(filePath, fileName, chunkSize, opts = {}) {
    const buf = fs.readFileSync(filePath);
    const total = Math.ceil(buf.length / chunkSize);
    const uploadId = 'chunktest' + Math.random().toString(16).slice(2, 8);
    const attempt = 'att' + Math.random().toString(16).slice(2, 8);
    const order = opts.reverse ? [...Array(total).keys()].reverse() : [...Array(total).keys()];
    for (const i of order) {
      if (opts.skip !== undefined && i === opts.skip) continue;
      const start = i * chunkSize;
      const piece = buf.subarray(start, Math.min(buf.length, start + chunkSize));
      const r = await fetch(BASE + '/api/upload-chunk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-upload-id': uploadId,
          'x-attempt': attempt,
          'x-file-name': encodeURIComponent(fileName),
          'x-file-size': String(buf.length),
          'x-chunk-index': String(i),
          'x-chunk-total': String(total),
          'x-chunk-offset': String(start),
          'x-chunk-len': String(piece.length),
        },
        body: piece,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { status: r.status, error: d.error, uploadId, total };
    }
    const f = await fetch(BASE + '/api/upload-finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, name: fileName, size: buf.length, total, attempt }),
    });
    const d = await f.json().catch(() => ({}));
    return { status: f.status, data: d, uploadId, total };
  }

  // имя с кириллицей, куски в обратном порядке — последний приезжает первым
  let r = await chunked('/home/user/testdata/Звонок с клиентом — 12 сентября.mp4', 'Звонок с клиентом — 12 сентября.mp4', 4194304, { reverse: true });
  console.log('  кириллица + обратный порядок →', r.status, JSON.stringify(r.data || r.error));

  // не-видео
  fs.writeFileSync('/tmp/notvideo.bin', 'это точно не видео');
  r = await chunked('/tmp/notvideo.bin', 'notvideo.bin', 4096);
  console.log('  не-видео →', r.status, r.data && r.data.error);

  // недосланный кусок
  r = await chunked(SRC, 'gappy.mp4', 4194304, { skip: 1 });
  console.log('  без куска №2 →', r.status, r.data && r.data.error);

  // неправильные заголовки
  r = await fetch(BASE + '/api/upload-chunk', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x',
  }).then(async (x) => ({ status: x.status }));
  console.log('  без заголовков →', r.status);

  /* Убираем за собой в том же прогоне, а не надеемся на суточную чистку:
     она рассчитана на возраст, а тестовый мусор свежий. Снимок рабочей папки
     ограничен ~128 МБ, и распухшая data/ вытесняет из него загруженное
     пользователем видео — тогда нарезка падает с «сервер перезапустился и
     потерял временные файлы». */
  for (const id of made.jobs) await fetch(BASE + '/api/jobs/' + id, { method: 'DELETE' }).catch(() => {});
  for (const id of made.uploads) await fetch(BASE + '/api/uploads/' + id, { method: 'DELETE' }).catch(() => {});
  const { execSync } = require('child_process');
  try { execSync('./clean.sh', { stdio: 'ignore' }); } catch (_) {}
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
