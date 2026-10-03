import time, os, sys, json
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173"
BIG = os.environ.get("BIGFILE") or "/home/user/testdata/Вебинар — запись, 40 минут.mp4"
OUT = "/home/user/report/shots40"
os.makedirs(OUT, exist_ok=True)
fails = []

def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)

def check(name, cond, extra=""):
    if not cond:
        fails.append(name)
    log(("OK   " if cond else "FAIL ") + name + (("  " + str(extra)) if extra else ""))

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    pg = ctx.new_page()
    errs, bad = [], []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("response", lambda r: bad.append(f"{r.status} {r.url.replace(BASE, '')}") if r.status >= 400 else None)

    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_timeout(2600)
    pg.evaluate("() => { const r = document.querySelector('#resetBtn'); if (r && !document.querySelector('#panel').hidden) r.click(); }")
    pg.wait_for_selector("#dropzone:not([hidden])", timeout=30000)
    pg.wait_for_timeout(400)
    log(f"цель: {BASE} · файл {os.path.getsize(BIG)/1024/1024:.0f} МБ")

    # ── 1. загрузка 40 минут ───────────────────────────────────
    t0 = time.time()
    pg.set_input_files("#fileInput", BIG)
    pg.wait_for_selector("#panel:not([hidden])", timeout=1800000)
    up = time.time() - t0
    log(f"загружено за {up:.1f}с")
    check("панель открылась", True)
    check("имя с кириллицей", any(c > "\u0400" for c in pg.inner_text("#srcName")), pg.inner_text("#srcName"))
    meta = pg.inner_text("#srcMeta")
    check("длительность 40:00", "40:00" in meta, meta)
    check("разрешение в мете", "640×360" in meta, meta)
    log("источник: " + pg.inner_text("#srcName") + " · " + meta)
    pg.screenshot(path=f"{OUT}/01-source.png", full_page=True)

    # ── 2. максимум кусков ─────────────────────────────────────
    pg.click('#overlapSeg button[data-overlap="1.5"]')   # перехлёст мог восстановиться прошлым
    pg.fill("#piecesNum", "80")
    pg.press("#piecesNum", "Tab")
    pg.wait_for_timeout(1200)
    ro = pg.inner_text("#readout").replace("\n", " | ")
    log("readout 80 кусков: " + ro)
    check("80 кусков", "80" in ro)
    check("длина куска 31.5 с (30 + перехлёст)", "00:31.5" in ro, ro)
    n_seg = len(pg.query_selector_all(".seg"))
    check("таймлайн: 80 сегментов", n_seg == 80, f"получено {n_seg}")
    check("первый короче на перехлёст", "короче" in pg.inner_text("#roEachNote"))
    pg.click('#overlapSeg button[data-overlap="2"]')
    pg.wait_for_timeout(900)
    log("readout после перехлёста 2 с: " + pg.inner_text("#readout").replace("\n", " | "))
    pg.screenshot(path=f"{OUT}/02-timeline80.png", full_page=True)

    # ── 3. граница: кусок короче 1.5 с ─────────────────────────
    pg.fill("#piecesNum", "80")
    pg.press("#piecesNum", "Tab")
    pg.wait_for_timeout(600)
    pg.click('#overlapSeg button[data-overlap="0.5"]')
    pg.wait_for_timeout(600)
    err_el = pg.eval_on_selector("#panelError", "e => ({hidden: e.hidden, text: e.textContent})")
    log("ошибка панели при 80×0.5: " + (err_el["text"] if not err_el["hidden"] else "—"))

    # ── 4. нарезка 80 кусками, быстро ──────────────────────────
    pg.fill("#piecesNum", "80")
    pg.press("#piecesNum", "Tab")
    pg.click('#overlapSeg button[data-overlap="1.5"]')
    pg.click('#modeSeg button[data-mode="fast"]')
    pg.wait_for_timeout(1200)
    t0 = time.time()
    pg.click("#cutBtn")
    pg.wait_for_selector("#results:not([hidden])", timeout=1800000)
    cut = time.time() - t0
    log(f"нарезка 80 кусками за {cut:.1f}с")
    cards = pg.query_selector_all(".card")
    check("80 карточек", len(cards) == 80, f"получено {len(cards)}")
    # превью грузятся лениво — прокручиваем выдачу до конца, тогда догрузятся все
    for frac in (0.25, 0.5, 0.75, 1.0):
        pg.evaluate(f"() => window.scrollTo(0, document.body.scrollHeight * {frac})")
        pg.wait_for_timeout(700)
    pg.wait_for_function(
        "() => [...document.querySelectorAll('.card-thumb img')].every(i => i.naturalWidth > 0)",
        timeout=180000)
    thumbs = pg.eval_on_selector_all(".card-thumb img", "e => e.map(i => i.naturalWidth)")
    check("все 80 превью загрузились", len(thumbs) == 80 and all(w > 0 for w in thumbs),
          f"{len(thumbs)} шт, мин. ширина {min(thumbs) if thumbs else 0}")
    log("мета: " + pg.inner_text("#resultsMeta").replace("\n", " | "))
    log("прогресс: " + pg.inner_text("#progressCount"))
    pg.screenshot(path=f"{OUT}/03-results80.png", full_page=True)

    # ── 5. архив ───────────────────────────────────────────────
    with pg.expect_download(timeout=1800000) as dl:
        pg.click("#zipBtn")
    z = dl.value
    check("zip скачан", os.path.getsize(z.path()) > 1000, f"{os.path.getsize(z.path())/1024/1024:.0f} МБ")
    log("zip: " + z.suggested_filename + f" · {os.path.getsize(z.path())/1024/1024:.0f} МБ")

    # ── 6. два куска по 20 минут ───────────────────────────────
    pg.click("#resetBtn")
    pg.wait_for_selector("#dropzone:not([hidden])", timeout=60000)
    pg.wait_for_timeout(400)
    t0 = time.time()
    pg.set_input_files("#fileInput", BIG)
    pg.wait_for_selector("#panel:not([hidden])", timeout=1800000)
    log(f"повторная загрузка за {time.time()-t0:.1f}с")
    pg.fill("#piecesNum", "2")
    pg.press("#piecesNum", "Tab")
    pg.wait_for_timeout(1000)
    log("readout 2 куска: " + pg.inner_text("#readout").replace("\n", " | "))
    check("длина куска 20:01.5 (20 мин + перехлёст)", "20:01.5" in pg.inner_text("#readout"), pg.inner_text("#readout").replace(chr(10)," | "))
    pg.click("#cutBtn")
    pg.wait_for_selector("#results:not([hidden])", timeout=1800000)
    cards2 = pg.query_selector_all(".card")
    check("2 карточки", len(cards2) == 2, f"получено {len(cards2)}")
    log("мета 2 куска: " + pg.inner_text("#resultsMeta").replace("\n", " | "))
    pg.screenshot(path=f"{OUT}/04-results2.png", full_page=True)

    real = [e for e in errs if "Failed to load resource" not in e and "413" not in e]
    log("— сетевые ошибки: " + (", ".join(bad[:8]) if bad else "нет"))
    log("— консоль: " + ("; ".join(real[:4]) if real else "чисто"))
    check("ошибок консоли нет", len(real) == 0, "; ".join(real[:2]))
    check("сетевых ошибок нет", len(bad) == 0, "; ".join(bad[:3]))
    ctx.close()
    b.close()

print("\n=== 40 МИНУТ: " + ("ПРОВАЛ " + str(len(fails)) if fails else "ВСЁ ЗЕЛЁНОЕ") + " ===")
for f in fails:
    print("  ✗ " + f)
