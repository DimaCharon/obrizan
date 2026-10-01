import time, os, json, urllib.request, sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4174"
BIG = os.environ.get("BIGFILE") or "/home/user/testdata/Запись звонка — 108 МБ.mp4"
OUT = "/home/user/shots/proxy"
os.makedirs(OUT, exist_ok=True)
fails = []

def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)

def check(name, cond, extra=""):
    if not cond:
        fails.append(name)
    log(("OK   " if cond else "FAIL ") + name + ("  " + extra if extra else ""))

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    errs, bad = [], []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("response", lambda r: bad.append(f"{r.status} {r.url.replace(BASE, '')}") if r.status >= 400 else None)

    log("цель: " + BASE)
    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_timeout(600)
    check("страница открылась", "НАРЕЗАТОР" in pg.content())
    # на чистый старт: убираем восстановленную с прошлого раза задачу
    pg.evaluate("() => { const r = document.querySelector('#resetBtn'); if (r && !document.querySelector('#panel').hidden) r.click(); }")
    pg.wait_for_selector("#dropzone:not([hidden])", timeout=30000)
    pg.wait_for_timeout(400)

    # большой файл через прокси с лимитом тела
    t0 = time.time()
    pg.set_input_files("#fileInput", BIG)
    try:
        pg.wait_for_selector("#panel:not([hidden])", timeout=900000)
        log(f"загружено за {time.time()-t0:.1f}с")
        check("панель открылась", True)
        check("имя с кириллицей", any(c > "\u0400" for c in pg.inner_text("#srcName")), pg.inner_text("#srcName"))
        log("источник: " + pg.inner_text("#srcName") + " · " + pg.inner_text("#srcMeta"))
        log("readout: " + pg.inner_text("#readout").replace("\n", " | "))
        pg.fill("#piecesNum", "4")
        pg.press("#piecesNum", "Tab")
        pg.wait_for_timeout(900)
        pg.click("#cutBtn")
        pg.wait_for_selector("#results:not([hidden])", timeout=900000)
        pg.wait_for_timeout(2000)
        cards = pg.query_selector_all(".card")
        check("4 карточки", len(cards) == 4, f"получено {len(cards)}")
        imgs = pg.eval_on_selector_all(".card-thumb img", "e => e.map(i => i.naturalWidth)")
        check("превью загрузились", all(w and w > 0 for w in imgs), str(imgs))
        log("мета: " + pg.inner_text("#resultsMeta").replace("\n", " | "))
        pg.screenshot(path=f"{OUT}/proxy-results.png", full_page=True)
    except Exception as e:
        check("загрузка большого файла", False, str(e).split("\n")[0][:200])
        vis = pg.eval_on_selector("#uploadStatus", "e => ({hidden: e.hidden, text: e.textContent})")
        log("статус в UI: " + json.dumps(vis, ensure_ascii=False))
        log("ошибка панели: " + (pg.inner_text("#panelError") if not pg.eval_on_selector("#panelError", "e => e.hidden") else "—"))
        pg.screenshot(path=f"{OUT}/proxy-fail.png", full_page=True)

    log("— ответы >= 400: " + (", ".join(bad[:12]) if bad else "нет"))
    # шум браузера об отклонённых прокси запросах — это не баг страницы
    real = [e for e in errs if "Failed to load resource" not in e and "413" not in e]
    log("— консоль (кроме шума прокси): " + ("; ".join(real[:4]) if real else "чисто"))
    check("ошибок консоли нет", len(real) == 0, "; ".join(real[:2]))
    ctx.close()
    b.close()

print("\n=== ПРОКСИ-ТЕСТ: " + ("ПРОВАЛ " + str(len(fails)) if fails else "ВСЁ ЗЕЛЁНОЕ") + " ===")
for f in fails:
    print("  ✗ " + f)
