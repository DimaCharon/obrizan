'use strict';

/* ============================================================
   НАРЕЗАТОР — клиент
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MAX_UPLOAD = 4 * 1024 ** 3;
const MIN_SEGMENT = 1.5;
const MAX_PIECES = 80;
const MULTIPART_LIMIT = 8 * 1024 ** 2;   // до 8 МБ грузим одним запросом
const CHUNK_START = 4 * 1024 ** 2;       // стартовый размер куска
const CHUNK_MIN = 32 * 1024;             // минимальный размер куска (прокси бывает жадным)
const CHUNK_WORKERS = 3;                 // параллельные запросы
const CHUNK_TRIES = 3;                   // попыток на кусок до уменьшения размера
const CHUNK_TIMEOUT = 120000;            // мс на кусок: дальше считаем соединение мёртвым
const WHOLE_TIMEOUT = 240000;            // мс на загрузку целым файлом
const API_TIMEOUT = 120000;              // мс на обычный запрос к сайту
const FIRST_BYTE_TIMEOUT = 45000;         // мс: если целый файл вообще не поехал — уходим на куски

const state = {
  file: null,        // мета исходника с сервера
  pieces: 20,
  overlap: 1.5,
  mode: 'accurate',
  plan: [],
  job: null,
  poll: null,
  restored: false,
};

/* ── форматирование ─────────────────────────────────────────── */

/* ответ может быть не JSON: прокси иногда отдаёт 413 простым текстом,
   и JSON.parse падает с «Unexpected non-whitespace character after JSON» */
async function readJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return { __notJson: true, status: res.status };
  }
}

/* fetch с потолком по времени: зависший прокси иначе молчит вечно,
   а человек видит только крутилку без единой подсказки */
async function fetchJson(url, opts = {}, ms = API_TIMEOUT) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  try {
    return await fetch(url, { ...opts, signal: ctl ? ctl.signal : undefined });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error('сервер не ответил — запрос висел слишком долго');
      e.status = 0;
      e.network = true;
      e.stalled = true;
      throw e;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* любая ошибка сети или разбора показывается человеку понятным текстом */
function friendlyError(err) {
  const msg = (err && err.message) || '';
  if (/non-whitespace character after JSON|Unexpected token|not valid JSON|Unexpected end of JSON/i.test(msg)) {
    return 'сервер ответил не JSON — между браузером и сайтом стоит прокси, который режет тело запроса';
  }
  if (err && err.stalled) {
    return 'связь с сайтом подвисла — запрос не дошёл за отведённое время, попробуйте снова';
  }
  /* 404 — это не опечатка в адресе, а потерянные временные файлы: сервер
     перезапустился и уже не знает ни исходника, ни задачи. Молчаливое
     «сервер ответил 404» тут бесполезно — человеку надо сказать, что делать. */
  if (err && err.status === 404) {
    return 'сервер перезапустился и потерял временные файлы — исходник и задача сброшены, загрузите видео заново';
  }
  if (err && err.status === 413) {
    return 'прокси не пропускает тело запроса — возьмите файл поменьше или откройте сайт локально: скачайте репозиторий и запустите ./start.sh';
  }
  if (err && err.status === 0) {
    return 'сеть отвалилась на середине загрузки — проверьте соединение и попробуйте снова';
  }
  return msg || 'что-то пошло не так';
}

function notJsonHint(data) {
  if (!data || !data.__notJson) return null;
  const s = data.status;
  /* 502/503/504 — это не прокси, который режет тело, а прокси, который не нашёл
     кому отдать запрос: сервер выключен, спит или перезапускается. Говорить тут
     про «обрезанное тело» значит отправлять человека искать несуществующую
     проблему в недра сети вместо того, чтобы просто перезагрузить страницу. */
  if (s === 502 || s === 503 || s === 504) {
    return `сайт за прокси не ответил (${s}) — сервер выключен или спит, а не режет тело запроса`;
  }
  return `сервер ответил ${s || '?'} и не JSON — похоже, тело или ответ режет прокси между браузером и сайтом`;
}

function fmtTime(sec, tenths = false) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  return tenths ? `${base}.${Math.floor((s % 1) * 10)}` : base;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

const plural = (n, one, few, many) => {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

/* ── часы, тикер, статус ────────────────────────────────────── */

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('#clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
setInterval(tickClock, 1000); tickClock();

(function buildTicker() {
  const chunk = ' нарезать <b>/</b> разделить <b>/</b> 40:00 → 20 кусков <b>/</b> перехлёст 1.5 с <b>/</b> mp4 + aac <b>/</b> локально, без облака <b>/</b> ffmpeg и арифметика <b>/</b> ';
  const track = $('#tickerTrack');
  track.innerHTML = `<span>${chunk.repeat(4)}</span><span>${chunk.repeat(4)}</span>`;
})();

function setStatus(text, kind = '') {
  $('#statusText').textContent = text;
  const dot = $('#statusDot');
  dot.className = `status-dot${kind ? ` is-${kind}` : ''}`;
}

/* ── элементы ───────────────────────────────────────────────── */

const el = {
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  pickBtn: $('#pickBtn'),
  panel: $('#panel'),
  resetBtn: $('#resetBtn'),
  srcName: $('#srcName'),
  srcMeta: $('#srcMeta'),
  piecesRange: $('#piecesRange'),
  piecesNum: $('#piecesNum'),
  chips: $('#chips'),
  overlapSeg: $('#overlapSeg'),
  modeSeg: $('#modeSeg'),
  modeNote: $('#modeNote'),
  roTotal: $('#roTotal'),
  roEach: $('#roEach'),
  roEachNote: $('#roEachNote'),
  roFormat: $('#roFormat'),
  roSize: $('#roSize'),
  cutBtn: $('#cutBtn'),
  cutBtnSub: $('#cutBtnSub'),
  panelError: $('#panelError'),
  timeline: $('#timeline'),
  ruler: $('#ruler'),
  tlHint: $('#tlHint'),
  uploadbar: $('#uploadbar'),
  uploadbarFill: $('#uploadbarFill'),
  uploadStatus: $('#uploadStatus'),
  progressCard: $('#progressCard'),
  progressTitle: $('#progressTitle'),
  progressCount: $('#progressCount'),
  progressFill: $('#progressFill'),
  progressNote: $('#progressNote'),
  results: $('#results'),
  resultsTitle: $('#resultsTitle'),
  resultsMeta: $('#resultsMeta'),
  grid: $('#grid'),
  zipBtn: $('#zipBtn'),
  recutBtn: $('#recutBtn'),
  newBtn: $('#newBtn'),
  modal: $('#modal'),
  modalVideo: $('#modalVideo'),
  modalTitle: $('#modalTitle'),
  modalMeta: $('#modalMeta'),
  modalDownload: $('#modalDownload'),
  footerStat: $('#footerStat'),
};

/* ── выбор и загрузка файла ─────────────────────────────────── */

el.pickBtn.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
el.fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  el.fileInput.value = '';
  if (f) handleFile(f);
});

['dragenter', 'dragover'].forEach((ev) => {
  window.addEventListener(ev, (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    el.dropzone.classList.add('is-dragover');
  });
});
['dragleave', 'dragend'].forEach((ev) => {
  window.addEventListener(ev, () => el.dropzone.classList.remove('is-dragover'));
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  el.dropzone.classList.remove('is-dragover');
  handleFile(e.dataTransfer.files[0]);
});

function localError(msg) {
  el.uploadStatus.hidden = false;
  el.uploadStatus.textContent = msg;
  el.uploadbar.hidden = true;
  setStatus('ошибка', 'err');
}

async function handleFile(file) {
  if (file.size > MAX_UPLOAD) {
    localError(`слишком большой файл — лимит ${fmtSize(MAX_UPLOAD)}`);
    return;
  }
  if (file.size === 0) { localError('файл пустой'); return; }

  el.uploadbar.hidden = false;
  el.uploadbarFill.style.width = '0%';
  el.uploadStatus.hidden = false;
  el.uploadStatus.textContent = `загружаем «${file.name}»… 0%`;
  setStatus('загружаем', 'busy');

  const chunked = file.size > MULTIPART_LIMIT;

  try {
    let meta;
    try {
      meta = chunked ? await uploadChunked(file) : await uploadFile(file);
    } catch (err) {
      // прокси не пропустил тело одним запросом — шлём тот же файл кусками
      if (!chunked && (err.status === 413 || err.status === 0 || err.network)) {
        el.uploadStatus.textContent = `загружаем «${file.name}»… кусками`;
        meta = await uploadChunked(file);
      } else {
        throw err;
      }
    }
    state.file = meta;
    state.job = null;
    onSourceReady();
  } catch (err) {
    localError(friendlyError(err));
  }
}

/* ── загрузка кусками ───────────────────────────────────────── */

/* Прокси между браузером и сайтом на большом теле может не только ответить
   413, но и просто оборвать соединение — тогда приходит onerror со status 0.
   Оба случая означают одно: кусок не прошёл по размеру, надо резать мельче. */
function sendChunk(headers, blob, query) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload-chunk?${query}`);
    xhr.timeout = CHUNK_TIMEOUT;
    Object.keys(headers).forEach((k) => xhr.setRequestHeader(k, headers[k]));
    let settled = false;
    const fail = (msg, status, network, src) => {
      if (settled) return;
      settled = true;
      const err = src || new Error(msg);
      err.status = status;
      err.network = !!network;
      reject(err);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) { settled = true; return resolve(data); }
      fail(friendlyError({ status: xhr.status, message: data.error || `сервер ответил ${xhr.status}` }), xhr.status);
    };
    xhr.onerror = () => fail('сеть отвалилась на середине загрузки — соединение оборвалось', 0, true);
    xhr.onabort = () => fail('загрузка прервана', 0, true);
    // кусок завис — это сетевая ошибка: её повторят, а потом и размер урежут
    xhr.ontimeout = () => {
      const err = new Error('кусок завис — сервер не ответил за две минуты');
      err.status = 0;
      err.network = true;
      err.stalled = true;
      fail(err.message, 0, true, err);
    };
    xhr.send(blob);
  });
}

function newUploadId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  return (Date.now().toString(16) + Math.random().toString(16).slice(2)).slice(0, 32);
}

function finishUpload(uploadId, name, size, total, attempt) {
  const q = new URLSearchParams({ id: uploadId, a: attempt, s: String(size), t: String(total) }).toString();
  return fetchJson(`/api/upload-finish?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, name, size, total, attempt }),
  }).then(async (r) => {
    const data = await readJson(r);
    if (r.ok && data.fileId) return data;
    const err = new Error(data.error || `сервер ответил ${r.status}`);
    err.status = r.status;
    throw err;
  });
}

async function uploadChunked(file) {
  const uploadId = newUploadId();
  let chunkSize = CHUNK_START;
  let confirmed = 0;

  for (;;) {
    const total = Math.max(1, Math.ceil(file.size / chunkSize));
    const attempt = newUploadId();
    let next = 0;
    let failure = null;      // Error — настоящая ошибка, загрузку бросаем
    let shrinkWith = null;   // Error — кусок не прошёл по размеру, режем мельче
    confirmed = 0;

    const worker = async () => {
      for (;;) {
        if (failure) return;
        const i = next;
        next += 1;
        if (i >= total) return;
        const start = i * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        const len = end - start;
        const headers = {
          'Content-Type': 'application/octet-stream',
          'x-upload-id': uploadId,
          'x-attempt': attempt,
          'x-file-name': encodeURIComponent(file.name),
          'x-file-size': String(file.size),
          'x-chunk-index': String(i),
          'x-chunk-total': String(total),
          'x-chunk-offset': String(start),
          'x-chunk-len': String(len),
        };

        // те же данные в query: прокси может срезать нестандартные заголовки
        const query = new URLSearchParams({
          id: uploadId, a: attempt, i: String(i), t: String(total),
          o: String(start), l: String(len), s: String(file.size), n: file.name,
        }).toString();

        let sent = false;
        let lastErr = null;
        for (let tries = 0; tries < CHUNK_TRIES && !failure && !shrinkWith; tries += 1) {
          try {
            await sendChunk(headers, file.slice(start, end), query);
            sent = true;
            break;
          } catch (err) {
            lastErr = err;
            // 413 — прокси назвал лимит прямо, режем кусок сразу
            if (err.status === 413) { shrinkWith = err; return; }
            // ответ сервера — это уже настоящая ошибка, дальше не пробуем
            if (!err.network) { failure = err; return; }
            // обрыв соединения: обычно тело не пропустили по размеру, но может
            // быть и моргнувшая сеть — поэтому кусок пробуем ещё раз
          }
        }
        if (!sent) { shrinkWith = lastErr; return; }

        confirmed += len;
        const pct = Math.min(100, Math.round((confirmed / file.size) * 100));
        el.uploadbarFill.style.width = `${pct}%`;
        el.uploadStatus.textContent = `загружаем «${file.name}»… ${pct}%`;
      }
    };

    await Promise.all(Array.from({ length: CHUNK_WORKERS }, worker));

    if (failure) throw failure;
    if (shrinkWith) {
      if (chunkSize <= CHUNK_MIN) throw shrinkWith;
      chunkSize = Math.max(CHUNK_MIN, Math.floor(chunkSize / 2));
      continue;
    }
    // все куски на диске — просим сервер собрать и проверить файл
    return await finishUpload(uploadId, file.name, file.size, total, attempt);
  }
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (firstByteTimer) clearTimeout(firstByteTimer);
      fn(arg);
    };
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append('video', file);
    xhr.open('POST', '/api/uploads');
    xhr.timeout = WHOLE_TIMEOUT;
    /* тело не ушло ни байтом — почти наверняка его режет прокси. Ждать четыре
       минуты незачем: сразу пробуем тот же файл кусками, они проходят везде. */
    let firstByteTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('загрузка не началась — тело запроса не пропускают');
      err.status = 0;
      err.network = true;
      err.stalled = true;
      reject(err);
    }, FIRST_BYTE_TIMEOUT);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      // первый байт пошёл — считаем, что канал живой, и снимаем сторож
      if (e.loaded > 0 && firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      const pct = Math.round((e.loaded / e.total) * 100);
      el.uploadbarFill.style.width = `${pct}%`;
      el.uploadStatus.textContent = `загружаем «${file.name}»… ${pct}%`;
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300 && data.fileId) { done(resolve, data); return; }
      // status нужен вызывающему коду: по 413 он поймёт, что тело не пропустили
      const err = new Error(data.error || `сервер ответил ${xhr.status}`);
      err.status = xhr.status;
      done(reject, err);
    };
    xhr.onerror = () => {
      const err = new Error('сеть отвалилась на середине загрузки');
      err.status = 0;
      err.network = true;
      done(reject, err);
    };
    // целым файлом не уложились — не ошибка, вызывающий код уйдёт на куски
    xhr.ontimeout = () => {
      const err = new Error('загрузка целым файлом не уложилась в отведённое время');
      err.status = 0;
      err.network = true;
      err.stalled = true;
      done(reject, err);
    };
    xhr.send(fd);
  });
}

/* ── исходник загружен ──────────────────────────────────────── */

function onSourceReady() {
  const f = state.file;
  el.dropzone.hidden = true;
  el.panel.hidden = false;
  el.results.hidden = true;
  el.progressCard.hidden = true;
  el.panelError.hidden = true;
  el.uploadbar.hidden = true;
  el.uploadStatus.hidden = true;

  el.srcName.textContent = f.name;
  el.srcMeta.innerHTML = [
    `<b>${fmtTime(f.duration, true)}</b> длительность`,
    f.width && f.height ? `${f.width}×${f.height}` : null,
    f.fps ? `${f.fps} fps` : null,
    f.videoCodec ? f.videoCodec : null,
    f.audioCodec ? `+ ${f.audioCodec}` : 'без звука',
    `<b>${fmtSize(f.size)}</b>`,
  ].filter(Boolean).join(' · ');

  setStatus('источник готов', 'ok');
  el.footerStat.textContent = `${f.name} · ${fmtTime(f.duration)} · ${fmtSize(f.size)}`;

  syncControls();
  refreshPlan();
  el.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ── управление ─────────────────────────────────────────────── */

function syncControls() {
  el.piecesRange.value = state.pieces;
  el.piecesNum.value = state.pieces;
  $$('#chips button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.pieces) === state.pieces));
  $$('#overlapSeg button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.overlap) === state.overlap));
  $$('#modeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === state.mode));
  el.modeNote.textContent = state.mode === 'accurate'
    ? 'перекодирование — границы точные, дольше'
    : 'копия потока — быстро, границы по ключевым кадрам';

  const each = state.file ? state.file.duration / state.pieces + state.overlap : 0;
  el.cutBtnSub.textContent = `${state.pieces} ${plural(state.pieces, 'кусок', 'куска', 'кусков')} · ≈ ${fmtTime(each, true)} каждый`;
  el.roFormat.textContent = state.mode === 'accurate' ? 'mp4 · h.264' : 'копия потока';
}

el.piecesRange.addEventListener('input', () => { state.pieces = Number(el.piecesRange.value); syncControls(); schedulePlan(); });
el.piecesNum.addEventListener('change', () => {
  let v = Math.round(Number(el.piecesNum.value) || 20);
  v = Math.max(2, Math.min(MAX_PIECES, v));
  state.pieces = v;
  syncControls(); schedulePlan();
});
el.chips.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.pieces = Number(b.dataset.pieces); syncControls(); schedulePlan();
});
el.overlapSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.overlap = Number(b.dataset.overlap); syncControls(); schedulePlan();
});
el.modeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.mode = b.dataset.mode; syncControls();
});

let planTimer = null;
function schedulePlan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(refreshPlan, 90);
}

function showPanelError(msg) {
  el.panelError.hidden = false;
  el.panelError.textContent = msg;
  el.cutBtn.disabled = true;
  setStatus('нужно поправить настройки', 'err');
}

async function refreshPlan() {
  if (!state.file) return;
  const seg = state.file.duration / state.pieces;
  if (seg < MIN_SEGMENT) {
    state.plan = [];
    el.timeline.innerHTML = '';
    el.ruler.innerHTML = '';
    el.roTotal.textContent = '—'; el.roEach.textContent = '—'; el.roSize.textContent = '—';
    showPanelError(`при ${state.pieces} кусках каждый был бы короче ${MIN_SEGMENT} с — возьмите меньше кусков`);
    return;
  }
  el.panelError.hidden = true;
  el.cutBtn.disabled = false;

  try {
    const res = await fetchJson('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: state.file.fileId, pieces: state.pieces, overlap: state.overlap }),
    });
    const data = await readJson(res);
    if (!res.ok) {
      showPanelError(notJsonHint(data) || data.error || 'не удалось построить план');
      return;
    }
    state.plan = data.plan;
    renderTimeline();
    renderReadout();
  } catch (err) {
    showPanelError(friendlyError(err));
  }
}

function renderReadout() {
  const n = state.plan.length;
  const first = state.plan[0];
  const rest = state.plan[n - 1];
  el.roTotal.textContent = n + ' ' + plural(n, 'кусок', 'куска', 'кусков');
  el.roEach.textContent = fmtTime(rest.duration, true);
  el.roEachNote.textContent = state.overlap > 0
    ? 'первый на ' + fmtTime(rest.duration - first.duration, true) + ' короче'
    : 'все равные';
  const approx = state.file.size * (1 + (n * state.overlap) / state.file.duration);
  el.roSize.textContent = '\u2248 ' + fmtSize(approx);
  const legend = document.getElementById('legendText');
  if (legend) {
    legend.textContent = state.overlap > 0
      ? '\u043f\u0435\u0440\u0435\u0445\u043b\u0451\u0441\u0442 ' + state.overlap + ' \u0441 \u2014 \u043d\u0430\u0447\u0430\u043b\u043e \u043a\u0430\u0436\u0434\u043e\u0433\u043e \u043a\u0443\u0441\u043a\u0430 \u0432\u0437\u044f\u0442\u043e \u0438\u0437 \u043f\u0440\u0435\u0434\u044b\u0434\u0443\u0449\u0435\u0433\u043e'
      : '\u043f\u0435\u0440\u0435\u0445\u043b\u0451\u0441\u0442 \u0432\u044b\u043a\u043b\u044e\u0447\u0435\u043d \u2014 \u043a\u0443\u0441\u043a\u0438 \u0438\u0434\u0443\u0442 \u0432\u0441\u0442\u044b\u043a';
  }
}

/* ── таймлайн ───────────────────────────────────────────────── */

function defaultHint() {
  return state.overlap > 0
    ? '\u043f\u0435\u0440\u0435\u0445\u043b\u0451\u0441\u0442 ' + state.overlap + ' \u0441 \u00b7 \u043d\u0430\u0432\u0435\u0434\u0438\u0442\u0435 \u2014 \u043f\u043e\u043a\u0430\u0436\u0435\u043c \u0433\u0440\u0430\u043d\u0438\u0446\u044b'
    : '\u043d\u0430\u0432\u0435\u0434\u0438\u0442\u0435 \u043d\u0430 \u043a\u0443\u0441\u043e\u043a \u2014 \u043f\u043e\u043a\u0430\u0436\u0435\u043c \u0433\u0440\u0430\u043d\u0438\u0446\u044b';
}

function renderTimeline() {
  const tl = el.timeline;
  tl.innerHTML = '';
  const D = state.file.duration;
  const n = state.plan.length;
  if (!n) return;
  const gapTotal = 2 * (n - 1);

  state.plan.forEach((p, i) => {
    const wPct = (p.duration / D) * 100;
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.dataset.i = String(i);
    seg.style.width = `calc(${wPct.toFixed(4)}% - ${(gapTotal / n).toFixed(3)}px)`;
    seg.title = `кусок ${i + 1}: ${fmtTime(p.start, true)} → ${fmtTime(p.end, true)}`;

    const fill = document.createElement('div');
    fill.className = 'seg-fill';
    seg.appendChild(fill);

    if (state.overlap > 0 && i > 0) {
      const ov = document.createElement('div');
      ov.className = 'seg-ov';
      ov.style.width = Math.min(100, (state.overlap / p.duration) * 100).toFixed(2) + '%';
      ov.title = '\u043f\u0435\u0440\u0435\u0445\u043b\u0451\u0441\u0442 ' + state.overlap + ' \u0441 \u0438\u0437 \u043a\u0443\u0441\u043a\u0430 ' + i;
      seg.appendChild(ov);
    }

    if (wPct > 4.5) {
      const num = document.createElement('span');
      num.className = 'seg-num';
      num.textContent = String(i + 1).padStart(2, '0');
      seg.appendChild(num);
    }
    if (wPct > 7) {
      const t = document.createElement('span');
      t.className = 'seg-time';
      t.textContent = `${fmtTime(p.start)} → ${fmtTime(p.end)}`;
      seg.appendChild(t);
    }

    seg.addEventListener('mouseenter', () => {
      el.tlHint.textContent = `кусок ${String(i + 1).padStart(2, '0')} · ${fmtTime(p.start, true)} → ${fmtTime(p.end, true)} · ${fmtTime(p.duration, true)}`;
    });
    seg.addEventListener('mouseleave', () => { el.tlHint.textContent = defaultHint(); });
    seg.addEventListener('click', () => openPiece(i));

    tl.appendChild(seg);
  });

  renderRuler(D);
  el.tlHint.textContent = defaultHint();
}

function renderRuler(D) {
  const r = el.ruler;
  r.innerHTML = '';
  const cands = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = cands.find((c) => D / c <= 12) || 3600;
  for (let t = 0; t <= D + 0.001; t += step) {
    const tick = document.createElement('span');
    tick.className = 'ruler-tick';
    tick.style.left = `${Math.min(100, (t / D) * 100).toFixed(3)}%`;
    tick.textContent = fmtTime(t);
    r.appendChild(tick);
  }
}

/* ── нарезка ────────────────────────────────────────────────── */

el.cutBtn.addEventListener('click', startCut);

async function startCut() {
  if (!state.file) return;
  el.cutBtn.disabled = true;
  el.panelError.hidden = true;
  setStatus('запуск нарезки', 'busy');
  el.results.hidden = true;

  let data;
  try {
    const res = await fetchJson('/api/cut', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: state.file.fileId,
        pieces: state.pieces,
        overlap: state.overlap,
        mode: state.mode,
      }),
    });
    data = await readJson(res);
    if (!res.ok) throw new Error(notJsonHint(data) || data.error || 'сервер отказал');
  } catch (err) {
    showPanelError(friendlyError(err));
    return;
  }

  state.job = data.job;
  el.progressCard.hidden = false;
  el.progressCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  updateProgress(state.job);
  state.poll = setInterval(pollJob, 900);
  pollJob();
}

async function pollJob() {
  if (!state.job) return;
  try {
    const res = await fetchJson(`/api/jobs/${state.job.id}`);
    const data = await readJson(res);
    if (!res.ok) {
      const err = new Error(notJsonHint(data) || data.error || `сервер ответил ${res.status}`);
      err.status = res.status;
      throw err;
    }
    state.job = data.job;
    updateProgress(state.job);
    if (state.job.status === 'done' || state.job.status === 'error') {
      clearInterval(state.poll);
      state.poll = null;
      finishJob(state.job);
    }
  } catch (err) {
    clearInterval(state.poll);
    state.poll = null;
    showPanelError(friendlyError(err));
  }
}

function updateProgress(job) {
  const done = job.results.filter((r) => r.status === 'done').length;
  const pct = Math.round((job.progress || 0) * 100);
  el.progressFill.style.width = `${pct}%`;
  el.progressCount.textContent = `${done} / ${job.pieces}`;
  el.progressTitle.textContent = job.status === 'done' ? 'нарезка завершена' : 'режем…';
  const running = job.results.find((r) => r.status === 'running');
  const next = job.results.find((r) => r.status === 'pending');
  const pad = (n) => String(n).padStart(2, '0');
  el.progressNote.textContent = running
    ? `кусок ${pad(running.index + 1)} · ${fmtTime(running.start, true)} → ${fmtTime(running.end, true)}`
    : job.status === 'done'
      ? 'все куски на месте'
      : next
        ? `ждём очереди — кусок ${pad(next.index + 1)}`
        : 'обработка';
  setStatus(`режем ${done}/${job.pieces}`, 'busy');

  // таймлайн
  $$('.seg', el.timeline).forEach((seg) => {
    const i = Number(seg.dataset.i);
    const r = job.results[i];
    if (!r) return;
    seg.classList.toggle('is-running', r.status === 'running');
    seg.classList.toggle('is-done', r.status === 'done');
    seg.classList.toggle('is-error', r.status === 'error');
    seg.classList.toggle('is-clickable', r.status === 'done');
    const fill = $('.seg-fill', seg);
    if (fill) fill.style.width = r.status === 'done' ? '100%' : `${Math.round((r.fraction || 0) * 100)}%`;
  });
}

function finishJob(job) {
  el.cutBtn.disabled = false;
  el.progressCard.hidden = true;
  el.results.hidden = false;
  el.newBtn.hidden = true;
  renderResults(job);

  const okCount = job.results.filter((r) => r.status === 'done').length;
  const size = job.results.reduce((s, r) => s + (r.size || 0), 0);
  el.resultsTitle.textContent = okCount === job.pieces
    ? `готово — ${job.pieces} ${plural(job.pieces, 'кусок', 'куска', 'кусков')}`
    : `готово с ошибками — ${okCount} из ${job.pieces}`;
  el.resultsMeta.textContent = [
    `${fmtTime(job.duration)} исходника`,
    `перехлёст ${job.overlap} с`,
    job.container.toUpperCase(),
    fmtSize(size),
    job.mode === 'fast' ? 'копия потока' : 'перекодирование',
  ].join(' · ');

  setStatus(okCount === job.pieces ? 'готово' : 'готово, есть ошибки', okCount === job.pieces ? 'ok' : 'err');
  el.footerStat.textContent = `${job.pieces} ${plural(job.pieces, 'кусок', 'куска', 'кусков')} · ${fmtSize(size)} · ${job.container.toUpperCase()}`;
  el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderResults(job) {
  el.grid.innerHTML = '';
  job.results.forEach((r) => {
    const alive = r.exists !== false;
    const card = document.createElement('article');
    card.className = 'card';
    if (r.status !== 'done' || !alive) card.classList.add(r.status === 'error' || !alive ? 'is-error' : 'is-pending');

    const thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    if (r.status === 'done' && alive) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = `превью куска ${r.index + 1}`;
      img.src = `${r.thumbUrl}?t=${job.id}`;
      // если превью-кадра нет (ffmpeg не смог) — не показываем битую картинку
      img.onerror = () => {
        img.remove();
        thumb.classList.add('is-missing');
      };
      thumb.appendChild(img);
    }

    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.textContent = String(r.index + 1).padStart(2, '0');
    thumb.appendChild(badge);

    if (r.status === 'done' && alive) {
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'card-play';
      play.setAttribute('aria-label', `Смотреть кусок ${r.index + 1}`);
      play.innerHTML = '<span><svg viewBox="0 0 16 16"><path d="M4 2l9 6-9 6z" fill="currentColor"/></svg></span>';
      play.addEventListener('click', () => openPiece(r.index));
      thumb.appendChild(play);
    }

    const body = document.createElement('div');
    body.className = 'card-body';
    const range = document.createElement('div');
    range.className = 'card-range';
    range.innerHTML = `${fmtTime(r.start, true)}<i>→</i>${fmtTime(r.end, true)}`;
    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = r.status !== 'done'
      ? (r.status === 'error' ? 'не удалось вырезать' : 'готовится…')
      : (alive
        ? `${fmtTime(r.duration, true)} · ${fmtSize(r.size)}${r.note ? ` · ${r.note}` : ''}`
        : 'файл уже удалён с диска');

    body.appendChild(range);
    body.appendChild(sub);

    if (r.status === 'done' && alive) {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const dl = document.createElement('a');
      dl.className = 'btn btn-ghost';
      dl.href = r.url;
      dl.setAttribute('download', '');
      dl.textContent = 'скачать';
      actions.appendChild(dl);
      body.appendChild(actions);
    }

    card.appendChild(thumb);
    card.appendChild(body);
    if (r.status === 'done' && alive) card.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('.card-play')) return;
      openPiece(r.index);
    });
    el.grid.appendChild(card);
  });
}

/* ── архив ──────────────────────────────────────────────────── */

el.zipBtn.addEventListener('click', () => {
  const job = state.job;
  if (!job) return;
  setStatus('собираем архив', 'busy');
  window.location.href = `/api/jobs/${job.id}/zip`;
  // job держим в замыкании: за 2.5 с пользователь может успеть нажать «убрать»
  setTimeout(() => setStatus(job.status === 'done' ? 'готово' : 'в работе', 'ok'), 2500);
});

el.recutBtn.addEventListener('click', () => {
  el.results.hidden = true;
  el.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* восстановленный запуск, исходник которого уже удалён: возвращаем загрузку */
el.newBtn.addEventListener('click', () => {
  if (state.job) fetch(`/api/jobs/${state.job.id}`, { method: 'DELETE' }).catch(() => {});
  state.job = null;
  state.file = null;
  state.plan = [];
  el.panel.hidden = true;
  el.results.hidden = true;
  el.progressCard.hidden = true;
  el.dropzone.hidden = false;
  el.newBtn.hidden = true;
  setStatus('готов к работе');
  el.footerStat.textContent = 'ожидаю видео';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

el.resetBtn.addEventListener('click', () => {
  clearInterval(state.poll);
  state.poll = null;
  if (state.file) {
    fetch(`/api/uploads/${state.file.fileId}`, { method: 'DELETE' }).catch(() => {});
  }
  state.file = null;
  state.job = null;
  state.plan = [];
  el.panel.hidden = true;
  el.results.hidden = true;
  el.progressCard.hidden = true;
  el.dropzone.hidden = false;
  el.uploadbar.hidden = true;
  el.uploadStatus.hidden = true;
  setStatus('готов к работе');
  el.footerStat.textContent = 'ожидаю видео';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ── превью куска ───────────────────────────────────────────── */

function openPiece(i) {
  const job = state.job;
  if (!job) return;
  const r = job.results[i];
  if (!r || r.status !== 'done' || r.exists === false) return;
  el.modalTitle.textContent = `кусок ${String(i + 1).padStart(2, '0')} · ${fmtTime(r.start, true)} → ${fmtTime(r.end, true)}`;
  el.modalMeta.textContent = `${fmtTime(r.duration, true)} · ${fmtSize(r.size)} · ${r.name}`;
  el.modalDownload.href = r.url;
  el.modalDownload.setAttribute('download', r.name);
  el.modalVideo.src = r.mediaUrl;
  el.modal.hidden = false;
  document.body.style.overflow = 'hidden';
  el.modalVideo.play().catch(() => {});
}

function closeModal() {
  el.modal.hidden = true;
  el.modalVideo.pause();
  el.modalVideo.removeAttribute('src');
  el.modalVideo.load();
  document.body.style.overflow = '';
}

$('#modalClose').addEventListener('click', closeModal);
el.modal.addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) closeModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.modal.hidden) closeModal(); });

/* ── восстановление последнего результата ───────────────────── */

(async function restore() {
  try {
    const res = await fetchJson('/api/jobs');
    const data = await readJson(res);
    const job = data.jobs && data.jobs[0];
    if (!job || job.status !== 'done') return;
    if (!job.results.some((r) => r.exists !== false)) return;

    state.job = job;
    el.progressCard.hidden = true;
    el.results.hidden = false;
    el.newBtn.hidden = true;
    renderResults(job);

    const okCount = job.results.filter((r) => r.status === 'done').length;
    const size = job.results.reduce((s, r) => s + (r.size || 0), 0);
    el.resultsTitle.textContent = `прошлый запуск — ${job.pieces} ${plural(job.pieces, 'кусок', 'куска', 'кусков')}`;
    el.resultsMeta.textContent = [
      job.sourceName,
      `перехлёст ${job.overlap} с`,
      (job.container || 'mp4').toUpperCase(),
      fmtSize(size),
      'файлы ещё на диске',
    ].join(' · ');
    el.footerStat.textContent = `${job.pieces} ${plural(job.pieces, 'кусок', 'куска', 'кусков')} · ${fmtSize(size)}`;
    setStatus('восстановлен прошлый результат', 'ok');

    // если исходник ещё на сервере — поднимаем и панель управления
    if (job.uploadAvailable) try {
      const r2 = await fetchJson(`/api/uploads/${job.fileId}`);
      if (r2.ok) {
        const meta = await r2.json();
        state.file = meta;
        state.pieces = job.pieces;
        state.overlap = job.overlap;
        state.mode = job.mode;
        state.plan = job.plan;
        el.panel.hidden = false;
        el.srcName.textContent = meta.name;
        el.srcMeta.innerHTML = [
          `<b>${fmtTime(meta.duration, true)}</b> длительность`,
          meta.width && meta.height ? `${meta.width}×${meta.height}` : null,
          meta.fps ? `${meta.fps} fps` : null,
          meta.videoCodec || null,
          meta.audioCodec ? `+ ${meta.audioCodec}` : 'без звука',
          `<b>${fmtSize(meta.size)}</b>`,
        ].filter(Boolean).join(' · ');
        syncControls();
        renderTimeline();
        renderReadout();
        el.dropzone.hidden = true;
      }
    } catch (_) {}
    // исходника нет — оставляем единственный выход: загрузить другое видео
    if (el.dropzone.hidden === false && el.panel.hidden) el.newBtn.hidden = false;
  } catch (_) {}
})();
