import time, json, os
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:4173"
OUT = "/home/user/shots/full"
SMALL = "/home/user/testdata/demo.mp4"
BIG = os.environ.get("BIGFILE") or "/home/user/testdata/Звонок с клиентом — 12 сентября.mp4"
os.makedirs(OUT, exist_ok=True)
fails = []

def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)

def check(name, cond, extra=""):
    mark = "OK  " if cond else "FAIL"
    if not cond:
        fails.append(f"{name} {extra}")
    log(f"{mark} {name} {extra}")

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900},
                        accept_downloads=True)
    pg = ctx.new_page()
    errs, bad = [], []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("response", lambda r: bad.append(f"{r.status} {r.url}") if r.status >= 400 else None)
    reqs = []
    pg.on("request", lambda r: reqs.append(r.url) if "/api/" in r.url else None)

    # ── 1. чистый старт ────────────────────────────────────────
    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_timeout(2600)
    pg.evaluate("() => { const r = document.querySelector('#resetBtn'); if (r && !document.querySelector('#panel').hidden) r.click(); }")
    pg.wait_for_selector("#dropzone:not([hidden])", timeout=30000)
    check("старт: дропзона видна", pg.eval_on_selector("#dropzone", "e => !e.hidden"))
    check("старт: панель скрыта", pg.eval_on_selector("#panel", "e => e.hidden"))
    check("старт: результатов нет", pg.eval_on_selector("#results", "e => e.hidden"))
    log("статус: " + pg.inner_text("#statusText"))

    # ── 2. малый файл: мультипарт ──────────────────────────────
    t0 = time.time()
    pg.set_input_files("#fileInput", SMALL)
    pg.wait_for_selector("#panel:not([hidden])", timeout=60000)
    log(f"малый файл загружен за {time.time()-t0:.1f}с")
    check("малый: панель открылась", True)
    check("малый: имя файла в карточке", "demo.mp4" in pg.inner_text("#srcName") + " · " + pg.inner_text("#srcMeta"))
    check("малый: ошибки нет", pg.eval_on_selector("#uploadStatus", "e => e.hidden"),
          pg.inner_text("#uploadStatus") if not pg.eval_on_selector("#uploadStatus", "e => e.hidden") else "")
    pg.wait_for_timeout(900)
    check("малый: план построен", len(pg.eval_on_selector_all(".seg", "e => e.map(s => s)")) > 0)
    log("readout: " + pg.inner_text("#readout").replace("\n", " | "))

    # ── 3. настройки ───────────────────────────────────────────
    pg.fill("#piecesNum", "12")
    pg.press("#piecesNum", "Tab")
    pg.wait_for_timeout(700)
    check("кусков 12", "12" in pg.inner_text("#readout"))
    n_seg = len(pg.query_selector_all(".seg"))
    check("таймлайн: 12 сегментов", n_seg == 12, f"получено {n_seg}")
    pg.click('#overlapSeg button[data-overlap="2"]')
    pg.wait_for_timeout(700)
    check("перехлёст 2 с", "2 с" in pg.inner_text("#legendText"))
    check("перехлёст в readout", "2" in pg.inner_text("#readout"))
    pg.click('#modeSeg button[data-mode="fast"]')
    pg.wait_for_timeout(500)
    check("режим быстрый", "быстро" in pg.inner_text("#modeSeg").lower())
    pg.screenshot(path=f"{OUT}/01-panel.png", full_page=True)

    # ── 4. нарезка ─────────────────────────────────────────────
    pg.click("#cutBtn")
    pg.wait_for_selector("#results:not([hidden])", timeout=180000)
    pg.wait_for_timeout(1200)
    log("прогресс: " + pg.inner_text("#progressCount") + " · " + pg.inner_text("#progressNote").replace("\n", " "))
    check("нарезка: результаты появились", True)
    cards = pg.query_selector_all(".card")
    check("нарезка: 12 карточек", len(cards) == 12, f"получено {len(cards)}")
    pg.wait_for_function("() => [...document.querySelectorAll('.card-thumb img')].every(i => i.naturalWidth > 0)", timeout=30000)
    thumbs = pg.eval_on_selector_all(".card-thumb img", "e => e.map(i => i.naturalWidth)")
    check("превью загрузились", all(w > 0 for w in thumbs), str(thumbs[:3]))
    log("мета: " + pg.inner_text("#resultsMeta").replace("\n", " | "))
    log("zip-бар: " + pg.inner_text("#resultsMeta").replace("\n", " "))
    pg.screenshot(path=f"{OUT}/02-results.png", full_page=True)

    # ── 5. модалка превью ──────────────────────────────────────
    cards[3].query_selector(".card-play").click()
    pg.wait_for_timeout(1200)
    check("модалка открылась", not pg.eval_on_selector("#modal", "e => e.hidden"))
    pg.screenshot(path=f"{OUT}/03-modal.png")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(400)
    check("модалка закрылась", pg.eval_on_selector("#modal", "e => e.hidden"))

    # ── 6. скачивание куска ────────────────────────────────────
    with pg.expect_download(timeout=120000) as dl:
        cards[5].query_selector(".card-actions a").click()
    d = dl.value
    path = d.path()
    check("скачивание куска", os.path.getsize(path) > 1000, f"{os.path.getsize(path)} байт")
    log("кусок: " + d.suggested_filename)

    # ── 7. zip ─────────────────────────────────────────────────
    with pg.expect_download(timeout=180000) as dl2:
        pg.click("#zipBtn")
    d2 = dl2.value
    check("zip скачан", os.path.getsize(d2.path()) > 1000, f"{os.path.getsize(d2.path())} байт")
    log("zip: " + d2.suggested_filename)

    # ── 8. большой файл: чанковая загрузка ─────────────────────
    pg.click("#resetBtn")
    pg.wait_for_selector("#dropzone:not([hidden])", timeout=30000)
    pg.wait_for_timeout(400)
    t0 = time.time()
    pg.set_input_files("#fileInput", BIG)
    pg.wait_for_selector("#panel:not([hidden])", timeout=600000)
    big_time = time.time() - t0
    log(f"большой файл ({os.path.getsize(BIG)/1024/1024:.0f} МБ) загружен за {big_time:.1f}с")
    check("большой: панель открылась", True)
    check("большой: имя с кириллицей", any(c > "\u0400" for c in pg.inner_text("#srcName")), pg.inner_text("#srcName"))
    check("большой: мета источника", "04:20" in pg.inner_text("#srcMeta") and "1280×720" in pg.inner_text("#srcMeta"), pg.inner_text("#srcMeta"))
    log("источник: " + pg.inner_text("#srcName") + " · " + pg.inner_text("#srcMeta").replace("\n", " | "))
    log("readout: " + pg.inner_text("#readout").replace("\n", " | "))
    pg.screenshot(path=f"{OUT}/04-big.png", full_page=True)

    # ── 9. нарезка большого ────────────────────────────────────
    pg.fill("#piecesNum", "6")
    pg.press("#piecesNum", "Tab")
    pg.wait_for_timeout(900)
    pg.click("#cutBtn")
    pg.wait_for_selector("#results:not([hidden])", timeout=600000)
    pg.wait_for_timeout(1500)
    cards2 = pg.query_selector_all(".card")
    check("большой: 6 карточек", len(cards2) == 6, f"получено {len(cards2)}")
    pg.wait_for_function("() => [...document.querySelectorAll('.card-thumb img')].every(i => i.naturalWidth > 0)", timeout=60000)
    thumbs2 = pg.eval_on_selector_all(".card-thumb img", "e => e.map(i => i.naturalWidth)")
    check("большой: превью загрузились", all(w > 0 for w in thumbs2), str(thumbs2))
    log("мета большого: " + pg.inner_text("#resultsMeta").replace("\n", " | "))
    pg.screenshot(path=f"{OUT}/05-big-results.png", full_page=True)
    with pg.expect_download(timeout=300000) as dl3:
        pg.click("#zipBtn")
    check("большой: zip скачан", os.path.getsize(dl3.value.path()) > 1000, f"{os.path.getsize(dl3.value.path())} байт")

    # ── 10. восстановление после перезагрузки ──────────────────
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(2500)
    restored = not pg.eval_on_selector("#panel", "e => e.hidden")
    check("перезагрузка: задача восстановлена", restored)
    if restored:
        log("после перезагрузки: " + pg.inner_text("#readout").replace("\n", " | "))
        log("статус: " + pg.inner_text("#statusText"))
    pg.screenshot(path=f"{OUT}/06-restored.png", full_page=True)

    # ── итоги ──────────────────────────────────────────────────
    log("— сетевые ошибки: " + (", ".join(bad) if bad else "нет"))
    uniq = []
    for e in errs:
        if e not in uniq:
            uniq.append(e)
    log("— ошибки консоли: " + ("; ".join(uniq[:6]) if uniq else "нет"))
    log(f"— запросов к /api: {len(reqs)}")
    chunk_reqs = [r for r in reqs if "upload-chunk" in r]
    log(f"— чанков загружено: {len(chunk_reqs)}")
    check("ошибок консоли нет", len(uniq) == 0, "; ".join(uniq[:3]))
    check("сетевых ошибок нет", len(bad) == 0, "; ".join(bad[:3]))

    ctx.close()
    b.close()

print("\n================ ИТОГИ ================")
if fails:
    print(f"ПРОВАЛОВ: {len(fails)}")
    for f in fails:
        print("  ✗ " + f)
else:
    print("ВСЁ ЗЕЛЁНОЕ")
