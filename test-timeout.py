"""Проверка таймаутов: подвешенный запрос больше не молчит вечно."""
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:4173"
fails = []

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page()
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.wait_for_timeout(500)

    # ── 1. константы на месте ──────────────────────────────────
    v = pg.evaluate("() => ({ c: CHUNK_TIMEOUT, w: WHOLE_TIMEOUT, a: API_TIMEOUT, f: FIRST_BYTE_TIMEOUT, min: CHUNK_MIN })")
    print(f"константы: кусок {v['c']} мс · целым {v['w']} мс · api {v['a']} мс · первый байт {v['f']} мс · пол {v['min']} Б")
    if not (v["c"] > 0 and v["w"] > 0 and v["a"] > 0 and v["f"] > 0):
        fails.append("константы таймаутов")

    # ── 2. у куска задан таймаут ───────────────────────────────
    r = pg.evaluate("""async () => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload-chunk?x=1');
      xhr.timeout = CHUNK_TIMEOUT;
      let settled = 'нет ответа';
      xhr.ontimeout = () => { settled = 'timeout'; };
      xhr.onload = () => { settled = 'load'; };
      xhr.onerror = () => { settled = 'error'; };
      xhr.send(new Blob([new Uint8Array(1024)]));
      await new Promise(r => setTimeout(r, 4000));
      return { settled, timeoutWas: xhr.timeout };
    }""")
    print(f"кусок: xhr.timeout={r['timeoutWas']} мс, за 4 с состояние «{r['settled']}»")
    if r["timeoutWas"] != 120000:
        fails.append("xhr.timeout не задан")

    # ── 3. fetchJson роняет зависший ответ с понятным текстом ──
    pg.route("**/api/plan", lambda route: None)
    t0 = time.time()
    out = pg.evaluate("""async () => {
      try {
        await fetchJson('/api/plan', { method: 'POST', body: '{}' }, 900);
        return { threw: false };
      } catch (e) {
        return { msg: e.message, status: e.status, network: !!e.network,
                 stalled: !!e.stalled, friendly: friendlyError(e) };
      }
    }""")
    print(f"fetchJson на подвешенном /api/plan: {time.time()-t0:.1f}с → {out}")
    if not out.get("threw", True):
        fails.append("fetchJson не упал на зависшем ответе")
    if out.get("friendly") != "связь с сайтом подвисла — запрос не дошёл за отведённое время, попробуйте снова":
        fails.append("текст ошибки таймаута: " + str(out.get("friendly")))
    pg.unroute("**/api/plan")

    # ── 3б. опрос задачи на 404 роняет понятную ошибку, а не «сервер ответил 404» ─
    pg.route("**/api/jobs/*", lambda route: route.fulfill(status=404, content_type="application/json", body='{"error":"задача не найдена"}'))
    # pollJob ошибку не бросает — он сам рисует её в панели, поэтому смотрим туда
    out35 = pg.evaluate("""async () => {
      state.job = { id: 'нет-такой' };
      await pollJob();
      const e = document.querySelector('#panelError');
      return { hidden: e.hidden, text: e.textContent.trim(), pollStopped: state.poll === null };
    }""")
    print(f"pollJob на 404: {out35}")
    if out35.get("hidden"):
        fails.append("pollJob на 404 ничего не показал")
    if not str(out35.get("text", "")).startswith("сервер перезапустился"):
        fails.append("pollJob на 404 даёт не тот текст: " + str(out35.get("text")))
    if not out35.get("pollStopped"):
        fails.append("опрос не остановился после 404")
    pg.unroute("**/api/jobs/*")

    # ── 4. целый файл, который не поехал, быстро уходит на куски ─
    pg.route("**/api/uploads", lambda route: None)
    t0 = time.time()
    out2 = pg.evaluate("""async () => {
      const f = new File([new Uint8Array(3000000)], 'проверка.mp4', { type: 'video/mp4' });
      try {
        await uploadFile(f);
        return { threw: false };
      } catch (e) {
        return { msg: e.message, status: e.status, network: !!e.network, stalled: !!e.stalled };
      }
    }""")
    took2 = time.time() - t0
    print(f"uploadFile, тело не поехало: {took2:.1f}с → {out2}")
    if not out2.get("threw", True):
        fails.append("uploadFile не упал")
    if not out2.get("network"):
        fails.append("ошибка не помечена network — не уйдёт на куски")
    if took2 > 70:
        fails.append(f"ждал первого байта {took2:.0f}с вместо ~45с")
    pg.unroute("**/api/uploads")

    # ── 5. живой запрос по-прежнему работает ───────────────────
    out3 = pg.evaluate("""async () => {
      const res = await fetchJson('/api/jobs');
      const d = await res.json();
      return { ok: res.ok, jobs: (d.jobs || []).length };
    }""")
    print(f"живой запрос /api/jobs: {out3}")
    if not out3["ok"]:
        fails.append("живой запрос сломан")

    # ── 6. текст прежних ошибок не сломался ────────────────────
    txt = pg.evaluate("""() => ({
      j413: friendlyError({ status: 413, message: 'Payload too large' }),
      j0:   friendlyError({ status: 0, message: 'network' }),
      json: friendlyError({ message: 'Unexpected non-whitespace character after JSON' }),
    })""")
    txt["j404"] = pg.evaluate("() => friendlyError({ status: 404, message: 'задача не найдена' })")
    txt["j502"] = pg.evaluate("() => notJsonHint({ __notJson: true, status: 502 })")
    txt["j503"] = pg.evaluate("() => notJsonHint({ __notJson: true, status: 503 })")
    txt["j200"] = pg.evaluate("() => notJsonHint({ __notJson: true, status: 200 })")
    print("старые тексты:", txt)
    if txt["j404"] != "сервер перезапустился и потерял временные файлы — исходник и задача сброшены, загрузите видео заново":
        fails.append("сломался текст 404")
    if txt["j502"] != "сайт за прокси не ответил (502) — сервер выключен или спит, а не режет тело запроса":
        fails.append("сломался текст 502")
    if txt["j503"] != "сайт за прокси не ответил (503) — сервер выключен или спит, а не режет тело запроса":
        fails.append("сломался текст 503")
    if not str(txt["j200"]).startswith("сервер ответил 200 и не JSON"):
        fails.append("сломался обычный не-JSON текст")
    if txt["j413"] != "прокси не пропускает тело запроса — возьмите файл поменьше или откройте сайт локально: скачайте репозиторий и запустите ./start.sh":
        fails.append("сломался текст 413")
    if txt["j0"] != "сеть отвалилась на середине загрузки — проверьте соединение и попробуйте снова":
        fails.append("сломался текст обрыва")

    b.close()

print("\n=== ТАЙМАУТЫ: " + ("ПРОВАЛ " + str(fails) if fails else "ВСЁ ЗЕЛЁНОЕ") + " ===")
