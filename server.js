'use strict';

/*
 * НАРЕЗАТОР — видеорезак.
 * Локальный сервер: загрузка → нарезка через ffmpeg → выдача кусков и ZIP.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const archiver = require('archiver');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const JOB_DIR = path.join(DATA_DIR, 'jobs');

for (const d of [UPLOAD_DIR, JOB_DIR]) fs.mkdirSync(d, { recursive: true });

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 4 * 1024 * 1024 * 1024);
const MAX_PIECES = 80;
const MIN_SEGMENT = 1.5; // секунд — меньше резать бессмысленно

/* ------------------------------------------------------------------ store */

const uploads = new Map(); // fileId -> meta
const jobs = new Map(); // jobId -> job
const queue = [];
let running = false;

const id = () => crypto.randomBytes(8).toString('hex');

function jobPath(jobId, ...rest) {
  return path.join(JOB_DIR, jobId, ...rest);
}

function pieceFile(job, index) {
  const r = job.results && job.results[index];
  return r ? path.join(JOB_DIR, job.id, 'pieces', r.file) : null;
}

function jobHasFiles(job) {
  const dir = path.join(JOB_DIR, job.id, 'pieces');
  try {
    const files = new Set(fs.readdirSync(dir));
    return job.results.some((r) => files.has(r.file));
  } catch (_) {
    return false;
  }
}

function persist(job) {
  try {
    fs.mkdirSync(JOB_DIR, { recursive: true });
    fs.writeFileSync(jobPath(job.id, 'status.json'), JSON.stringify(job));
  } catch (_) { /* диск может быть занят — не критично */ }
}

/* ------------------------------------------------------------------- util */

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(new Error('ffprobe: не удалось прочитать файл'));
      const v = data.streams.find((s) => s.codec_type === 'video');
      const a = data.streams.find((s) => s.codec_type === 'audio');
      if (!v) return reject(new Error('в файле нет видеодорожки'));
      const fps = v.avg_frame_rate && v.avg_frame_rate !== '0/0'
        ? Number((v.avg_frame_rate.split('/')[0] / v.avg_frame_rate.split('/')[1]).toFixed(3))
        : null;
      resolve({
        duration: Number(data.format.duration) || 0,
        width: v.width || null,
        height: v.height || null,
        fps,
        videoCodec: v.codec_name || null,
        audioCodec: a ? a.codec_name : null,
        audioChannels: a ? a.channels : 0,
        bitrate: Number(data.format.bit_rate) || null,
      });
    });
  });
}

function cutPiece(input, output, start, duration, mode, onProgress) {
  return new Promise((resolve, reject) => {
    const copy = mode === 'fast';
    const args = copy
      ? ['-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero']
      : [
        '-map', '0:v:0', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
        '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart',
      ];
    args.push('-t', duration.toFixed(3));

    let settled = false;
    const cmd = ffmpeg(input)
      .inputOptions(['-ss', start.toFixed(3)])
      .outputOptions(args)
      .output(output)
      .on('start', (cli) => { if (process.env.DEBUG) console.log('  $', cli); })
      .on('progress', (p) => {
        if (onProgress && p && typeof p.percent === 'number') {
          onProgress(Math.max(0, Math.min(100, p.percent)) / 100);
        }
      })
      .on('end', () => { settled = true; resolve(); })
      .on('error', (err) => { if (!settled) reject(err); });

    cmd.run();
  });
}

function grabFrame(input, at, output) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .inputOptions(['-ss', Math.max(0, at).toFixed(3)])
      .outputOptions(['-frames:v', '1', '-vf', "scale='min(560,iw)':-2", '-q:v', '4'])
      .output(output)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

/* превью-кадр: пробуем середину куска, потом начало, потом первый кадр вообще */
async function makeThumb(input, duration, output) {
  const attempts = [duration / 2, Math.min(0.05, duration), 0];
  for (const at of attempts) {
    try {
      await grabFrame(input, at, output);
      if (fs.existsSync(output) && fs.statSync(output).size > 0) return;
    } catch (_) { /* пробуем следующую точку */ }
  }
  throw new Error('не удалось вырезать превью-кадр');
}

function tc(seconds, withTenths) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  if (!withTenths) return base;
  return `${base}.${Math.floor((s % 1) * 10)}`;
}

function slug(start, end) {
  return `${tc(start, false).replace(/:/g, 'm')}s-${tc(end, false).replace(/:/g, 'm')}s`;
}

/* ------------------------------------------------------------------ routes */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, req.params.fileId || id());
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 8) || '.mp4';
      cb(null, `source${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
});

// HTML не кэшируем вообще, ассеты — с обязательной проверкой. Прокси превью
// тоже умеет кэшировать, поэтому у ассетов в URL есть версия (см. index.html).
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  maxAge: 0,
  setHeaders: (res, filePath) => {
    const isHtml = String(filePath).endsWith('.html');
    // no-cache заставляет браузер (и прокси) перепровердать файл по ETag,
    // а смена ?v= в index.html гарантированно сбрасывает кэш целиком
    res.setHeader('Cache-Control', isHtml ? 'no-store, must-revalidate' : 'no-cache, must-revalidate');
  },
}));
app.use('/media', express.static(JOB_DIR, { maxAge: 0, fallthrough: false }));

/* список задач — чтобы страница после перезагрузки восстановила результат */
app.get('/api/jobs', (req, res) => {
  const list = [...jobs.values()]
    .filter((j) => j.status !== 'done' || jobHasFiles(j))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 12)
    .map((j) => ({
      id: j.id,
      fileId: j.fileId,
      sourceName: j.sourceName,
      duration: j.duration,
      pieces: j.pieces,
      overlap: j.overlap,
      mode: j.mode,
      container: j.container,
      status: j.status,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      plan: j.plan,
      results: publicResults(j),
      totalSize: j.results.reduce((s, r) => s + (r.size || 0), 0),
      uploadAvailable: uploads.has(j.fileId),
      progress: j.progress,
      error: j.error,
    }));
  res.json({ jobs: list, limits: { maxPieces: MAX_PIECES, minSegment: MIN_SEGMENT, maxUpload: MAX_UPLOAD } });
});

app.get('/api/uploads/:fileId', (req, res) => {
  const meta = uploads.get(req.params.fileId);
  if (!meta) return res.status(404).json({ error: 'файл не найден' });
  res.json(meta);
});

app.delete('/api/uploads/:fileId', (req, res) => {
  const meta = uploads.get(req.params.fileId);
  if (!meta) return res.status(404).json({ error: 'файл не найден' });
  try { fs.rmSync(path.join(UPLOAD_DIR, req.params.fileId), { recursive: true, force: true }); } catch (_) {}
  uploads.delete(req.params.fileId);
  res.json({ ok: true });
});

/* загрузка */
app.post('/api/uploads', (req, res) => {
  upload.single('video')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `файл больше лимита (${humanSize(MAX_UPLOAD)})`
        : `загрузка не удалась: ${err.message}`;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'файл не получен' });

    const fileId = path.basename(path.dirname(req.file.path));
    try {
      const info = await probe(req.file.path);
      const meta = {
        fileId,
        name: req.file.originalname || 'video',
        size: req.file.size,
        container: path.extname(req.file.path).slice(1),
        ...info,
      };
      uploads.set(fileId, meta);
      try {
        fs.writeFileSync(path.join(path.dirname(req.file.path), 'meta.json'), JSON.stringify({
          name: meta.name, size: meta.size,
        }));
      } catch (_) {}
      res.json(meta);
    } catch (e) {
      try { fs.rmSync(path.dirname(req.file.path), { recursive: true, force: true }); } catch (_) {}
      res.status(415).json({ error: e.message || 'не похоже на видео' });
    }
  });
});

/* ── загрузка кусками: обходит лимиты прокси на тело запроса ───────────── */

const CHUNK_MAX = 64 * 1024 * 1024;

function safeExt(name) {
  const ext = path.extname(String(name || '')).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8);
  return ext || '.mp4';
}

const uploadState = new Map(); // id -> {dir, target, name, size, total, attempt, chunks: Map, sum}

app.post('/api/upload-chunk', async (req, res) => {
  // метаданные чанка дублируются в query: часть прокси срезает нестандартные
  // x- заголовки, а query доходит всегда
  const q = req.query || {};
  const id = String(req.headers['x-upload-id'] || q.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  let rawName = '';
  let nameEncoded = false;
  if (req.headers['x-file-name']) { rawName = String(req.headers['x-file-name']).slice(0, 600); nameEncoded = true; }
  else if (q.n) { rawName = String(q.n).slice(0, 600); }
  let name = 'video';
  if (nameEncoded) { try { name = decodeURIComponent(rawName); } catch (_) { name = rawName; } }
  else name = rawName;
  name = name.replace(/[\u0000-\u001f\/\\]/g, '_').slice(0, 260) || 'video';
  const attempt = String(req.headers['x-attempt'] || q.a || '').slice(0, 64);
  const index = Number(req.headers['x-chunk-index'] ?? q.i);
  const total = Number(req.headers['x-chunk-total'] ?? q.t);
  const offset = Number(req.headers['x-chunk-offset'] ?? q.o);
  const len = Number(req.headers['x-chunk-len'] ?? q.l);
  const fileSize = Number(req.headers['x-file-size'] ?? q.s);

  if (!id) return res.status(400).json({ error: 'нет идентификатора загрузки' });
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total < 1 || index >= total) {
    return res.status(400).json({ error: 'битые заголовки чанка' });
  }
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(len) || len <= 0 || len > CHUNK_MAX) {
    return res.status(400).json({ error: 'битые смещение или длина чанка' });
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_UPLOAD) {
    return res.status(400).json({ error: `файл больше лимита (${humanSize(MAX_UPLOAD)})` });
  }
  if (offset + len > fileSize) return res.status(400).json({ error: 'чанок вылезает за размер файла' });

  const dir = path.join(UPLOAD_DIR, id);
  const target = path.join(dir, `source${safeExt(name)}`);

  try {
    fs.mkdirSync(dir, { recursive: true });

    // куски приходят параллельно и в любом порядке, последний может быть
    // самым маленьким — поэтому сборку подтверждает /api/upload-finish.
    // новая попытка (другой размер куска) узнаётся по токену attempt
    let st = uploadState.get(id);
    if (!st || st.attempt !== attempt) {
      st = { dir, target, name, size: fileSize, total, attempt, chunks: new Map(), sum: 0 };
      uploadState.set(id, st);
      if (!fs.existsSync(target)) fs.writeFileSync(target, Buffer.alloc(0));
    } else if (st.total !== total || st.size !== fileSize) {
      return res.status(400).json({ error: 'размер куска разошёлся внутри попытки' });
    }

    const parts = [];
    for await (const part of req) parts.push(part);
    const buf = Buffer.concat(parts);
    if (buf.length !== len) {
      return res.status(400).json({ error: `пришло ${buf.length} байт вместо ${len}` });
    }

    const fh = await fs.promises.open(target, 'r+');
    try {
      await fh.write(buf, 0, buf.length, offset);
    } finally {
      await fh.close();
    }

    st.chunks.set(index, len);
    st.sum = [...st.chunks.values()].reduce((a, b) => a + b, 0);
    return res.json({ ok: true, received: offset + len, complete: st.sum === fileSize });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'не удалось принять чанк' });
  }
});

app.post('/api/upload-finish', async (req, res) => {
  const q = req.query || {};
  const b = req.body || {};
  const id = String(b.uploadId || q.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const size = Number(b.size ?? q.s);
  const total = Number(b.total ?? q.t);
  const attempt = String(b.attempt || q.a || '').slice(0, 64);

  const st = uploadState.get(id);
  if (!st) return res.status(400).json({ error: 'загрузка не найдена — файл не добрался' });
  if (st.size !== size || st.total !== total || (attempt && st.attempt !== attempt)) {
    return res.status(400).json({ error: 'параметры загрузки разошлись' });
  }
  if (st.sum !== size) {
    const missing = [];
    for (let i = 0; i < total; i += 1) if (!st.chunks.has(i)) missing.push(i + 1);
    return res.status(400).json({ error: `не долели куски: ${missing.slice(0, 8).join(', ')}` });
  }

  try {
    const fh = await fs.promises.open(st.target, 'r+');
    try { await fh.truncate(size); } finally { await fh.close(); }

    let info;
    try {
      info = await probe(st.target);
    } catch (_) {
      try { fs.rmSync(st.dir, { recursive: true, force: true }); } catch (__) {}
      uploadState.delete(id);
      return res.status(415).json({ error: 'не похоже на видео — проверьте файл' });
    }

    fs.writeFileSync(path.join(st.dir, 'meta.json'), JSON.stringify({ name: st.name, size }));
    const meta = {
      fileId: id,
      name: st.name,
      size,
      container: path.extname(st.target).slice(1),
      ...info,
    };
    uploads.set(id, meta);
    uploadState.delete(id);
    return res.json(meta);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'не удалось собрать файл' });
  }
});

/* превью плана нарезки (для таймлайна до запуска) */
app.post('/api/plan', (req, res) => {
  const { fileId, pieces, overlap } = req.body || {};
  const meta = uploads.get(fileId);
  if (!meta) return res.status(404).json({ error: 'файл не найден' });
  try {
    res.json({ plan: buildPlan(meta.duration, pieces, overlap) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function buildPlan(duration, piecesRaw, overlapRaw) {
  const pieces = Math.floor(Number(piecesRaw));
  const overlap = Math.max(0, Math.min(5, Number(overlapRaw) || 0));
  if (!Number.isFinite(pieces) || pieces < 2) throw new Error('нужно минимум 2 куска');
  if (pieces > MAX_PIECES) throw new Error(`максимум ${MAX_PIECES} кусков`);
  if (!(duration > 0)) throw new Error('не удалось определить длительность');

  const seg = duration / pieces;
  if (seg < MIN_SEGMENT) {
    throw new Error(`при ${pieces} кусках каждый был бы короче ${MIN_SEGMENT} с — уменьшите количество`);
  }

  const plan = [];
  for (let i = 0; i < pieces; i += 1) {
    const start = Math.max(0, i * seg - overlap);
    const end = Math.min(duration, (i + 1) * seg);
    plan.push({
      index: i,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number((end - start).toFixed(3)),
    });
  }
  return plan;
}

/* запуск нарезки */
app.post('/api/cut', (req, res) => {
  const { fileId, pieces, overlap, mode } = req.body || {};
  const meta = uploads.get(fileId);
  if (!meta) return res.status(404).json({ error: 'исходник не найден, загрузите видео заново' });

  let plan;
  try {
    plan = buildPlan(meta.duration, pieces, overlap);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const jobId = id();
  const jobDir = path.join(JOB_DIR, jobId);
  fs.mkdirSync(path.join(jobDir, 'pieces'), { recursive: true });
  fs.mkdirSync(path.join(jobDir, 'thumbs'), { recursive: true });

  const useMp4 = mode === 'fast'
    ? ['h264', 'hevc', 'mpeg4', 'vp8', 'vp9', 'av1'].includes(meta.videoCodec)
      && (!meta.audioCodec || ['aac', 'mp3', 'opus', 'ac3', 'eac3', 'vorbis', 'flac'].includes(meta.audioCodec))
    : true;
  const container = useMp4 ? 'mp4' : 'mkv';

  const job = {
    id: jobId,
    fileId,
    sourceName: meta.name,
    duration: meta.duration,
    pieces: plan.length,
    overlap: Number(overlap) || 0,
    mode: mode === 'fast' ? 'fast' : 'accurate',
    container,
    sourceFile: path.basename(path.join(UPLOAD_DIR, fileId, `source${meta.container ? '.' + meta.container : '.mp4'}`)),
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    plan,
    results: plan.map((p) => ({
      index: p.index,
      file: `cut-${String(p.index + 1).padStart(2, '0')}_${slug(p.start, p.end)}.${container}`,
      name: `cut-${String(p.index + 1).padStart(2, '0')}_${slug(p.start, p.end)}.${container}`,
      start: p.start,
      end: p.end,
      duration: p.duration,
      size: null,
      status: 'pending',
      error: null,
    })),
  };

  jobs.set(jobId, job);
  persist(job);
  queue.push(jobId);
  pump();

  res.json({ jobId, job: publicJob(job) });
});

function publicResults(job) {
  return job.results.map((r) => ({
    ...r,
    exists: fs.existsSync(path.join(JOB_DIR, job.id, 'pieces', r.file)),
    url: `/api/download/${job.id}/${r.index}`,
    mediaUrl: `/media/${job.id}/pieces/${r.file}`,
    thumbUrl: `/media/${job.id}/thumbs/${String(r.index + 1).padStart(2, '0')}.jpg`,
  }));
}

function publicJob(job) {
  return {
    id: job.id,
    sourceName: job.sourceName,
    duration: job.duration,
    pieces: job.pieces,
    overlap: job.overlap,
    mode: job.mode,
    container: job.container,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    plan: job.plan,
    results: publicResults(job),
    totalSize: job.results.reduce((s, r) => s + (r.size || 0), 0),
  };
}

app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'задача не найдена' });
  res.json({ job: publicJob(job) });
});

app.delete('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'задача не найдена' });
  try { fs.rmSync(path.join(JOB_DIR, req.params.jobId), { recursive: true, force: true }); } catch (_) {}
  jobs.delete(req.params.jobId);
  res.json({ ok: true });
});

/* скачивание одного куска */
app.get('/api/download/:jobId/:index', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'задача не найдена' });
  const i = Number(req.params.index);
  const r = job.results[i];
  if (!r) return res.status(404).json({ error: 'кусок не найден' });
  const file = pieceFile(job, i);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'файл ещё не готов' });

  res.setHeader('Content-Type', job.container === 'mkv' ? 'video/x-matroska' : 'video/mp4');
  res.setHeader('Content-Length', fs.statSync(file).size);
  res.setHeader('Content-Disposition', `attachment; filename="${r.name}"`);
  fs.createReadStream(file).pipe(res);
});

/* ZIP всего */
app.get('/api/jobs/:jobId/zip', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'задача не найдена' });
  const ready = job.results.filter((r) => r.status === 'done' && fs.existsSync(path.join(JOB_DIR, job.id, 'pieces', r.file)));
  if (!ready.length) return res.status(409).json({ error: 'нечего архивировать' });

  const zipName = `narez-${String(job.pieces)}x-${slug(job.plan[0].start, job.plan[job.plan.length - 1].end)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => {
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  archive.pipe(res);
  ready.forEach((r) => {
    archive.file(pieceFile(job, r.index), { name: r.name });
  });
  archive.finalize();
});

/* --------------------------------------------------------------- pipeline */

async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  persist(job);

  const src = path.join(UPLOAD_DIR, job.fileId, job.sourceFile);
  const piecesDir = path.join(JOB_DIR, job.id, 'pieces');
  const thumbsDir = path.join(JOB_DIR, job.id, 'thumbs');

  for (let i = 0; i < job.plan.length; i += 1) {
    const p = job.plan[i];
    const r = job.results[i];
    r.status = 'running';
    r.error = null;
    persist(job);

    const out = path.join(piecesDir, r.file);
    let ok = false;
    try {
      await cutPiece(src, out, p.start, p.duration, job.mode, (f) => {
        job.progress = (i + f) / job.plan.length;
        r.fraction = f;
      });
      ok = fs.existsSync(out) && fs.statSync(out).size > 0;
    } catch (e) {
      if (job.mode === 'fast') {
        // потоковое копирование не всегда возможно — перекодируем этот кусок
        try {
          await cutPiece(src, out, p.start, p.duration, 'accurate', (f) => {
            job.progress = (i + f) / job.plan.length;
            r.fraction = f;
          });
          ok = fs.existsSync(out) && fs.statSync(out).size > 0;
          r.note = 'перекодирован';
        } catch (_) { /* оставим ошибку ниже */ }
      }
    }

    if (ok) {
      r.status = 'done';
      r.size = fs.statSync(out).size;
      r.fraction = 1;
    } else {
      r.status = 'error';
      r.error = 'ffmpeg не смог вырезать фрагмент';
      try { fs.rmSync(out, { force: true }); } catch (_) {}
    }

    job.progress = (i + 1) / job.plan.length;
    persist(job);

    // превью-кадр из середины куска
    try {
      await makeThumb(out, p.duration, path.join(thumbsDir, `${String(i + 1).padStart(2, '0')}.jpg`));
    } catch (_) { /* превью необязательно */ }
  }

  const failed = job.results.filter((r) => r.status === 'error').length;
  job.status = failed === job.results.length ? 'error' : 'done';
  job.error = failed ? `${failed} из ${job.results.length} кусков не удались` : null;
  job.finishedAt = Date.now();
  persist(job);
}

async function pump() {
  if (running) return;
  const jobId = queue.shift();
  if (!jobId) return;
  const job = jobs.get(jobId);
  if (!job) return pump();
  running = true;
  try {
    await runJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = String((e && e.message) || e);
    job.finishedAt = Date.now();
    persist(job);
  }
  running = false;
  pump();
}

/* восстановление исходников с диска при перезапуске */
async function restoreUploads() {
  const day = 24 * 3600 * 1000;
  let dirs = [];
  try { dirs = fs.readdirSync(UPLOAD_DIR); } catch (_) { return; }
  await Promise.all(dirs.map(async (dir) => {
    const full = path.join(UPLOAD_DIR, dir);
    const src = (() => {
      try { return fs.readdirSync(full).find((f) => f.startsWith('source')); } catch (_) { return null; }
    })();
    if (!src) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {}
      return;
    }
    const file = path.join(full, src);
    let st;
    try { st = fs.statSync(file); } catch (_) { return; }
    if (Date.now() - st.mtimeMs > day) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {}
      return;
    }
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(path.join(full, 'meta.json'), 'utf8')); } catch (_) {}
    try {
      const info = await probe(file);
      uploads.set(dir, {
        fileId: dir,
        name: saved.name || src,
        size: saved.size || st.size,
        container: path.extname(src).slice(1),
        ...info,
      });
    } catch (_) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {}
    }
  }));
}

/* восстановление задач с диска при перезапуске */
(function restore() {
  try {
    for (const dir of fs.readdirSync(JOB_DIR)) {
      const f = path.join(JOB_DIR, dir, 'status.json');
      if (!fs.existsSync(f)) continue;
      const job = JSON.parse(fs.readFileSync(f, 'utf8'));
      jobs.set(job.id, job);
    }
  } catch (_) {}
})();

/* чистка старых задач (старше 24 часов) */
(function cleanup() {
  const day = 24 * 3600 * 1000;
  for (const job of jobs.values()) {
    if (job.createdAt && Date.now() - job.createdAt > day) {
      try { fs.rmSync(path.join(JOB_DIR, job.id), { recursive: true, force: true }); } catch (_) {}
      jobs.delete(job.id);
    }
  }
})();

app.use('/api', (req, res) => res.status(404).json({ error: 'нет такого метода' }));

(async function boot() {
  await restoreUploads();
  app.listen(PORT, HOST, () => {
    console.log(`НАРЕЗАТОР → http://${HOST}:${PORT} · исходников на диске: ${uploads.size}`);
  });
})();
