import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:4173"
OUT = "/home/user/shots"

def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1560, "height": 1050})
    pg = ctx.new_page()
    errs, failed = [], []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("response", lambda r: failed.append(f"{r.status} {r.url}") if r.status >= 400 else None)

    # 1. чистый старт
    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_timeout(900)
    log("старт: dropzone виден=" + str(pg.eval_on_selector("#dropzone", "e => !e.hidden"))
        + " панель скрыта=" + str(pg.eval_on_selector("#panel", "e => e.hidden"))
        + " результаты скрыты=" + str(pg.eval_on_selector("#results", "e => e.hidden"))
        + " модалка скрыта=" + str(pg.eval_on_selector("#modal", "e => e.hidden")))
    pg.screenshot(path=f"{OUT}/01-hero.png", full_page=True)

    # 2. загрузка + настройка
    pg.set_input_files("#fileInput", "/home/user/testdata/test.mp4")
    pg.wait_for_selector("#panel:not([hidden])", timeout=60000)
    pg.wait_for_timeout(1000)
    pg.fill("#piecesNum", "20")
    pg.press("#piecesNum", "Tab")
    pg.click('#overlapSeg button[data-overlap="1.5"]')
    pg.wait_for_timeout(1200)
    log("план: " + pg.inner_text("#readout").replace("\n", " | "))
    log("подсказка: " + pg.inner_text("#tlHint"))
    log("легенда: " + pg.inner_text("#legendText"))
    log("сегментов: " + str(pg.eval_on_selector_all(".seg", "e => e.length")))
    log("кнопка: " + pg.inner_text("#cutBtn").replace("\n", " "))

    # 3. нарезка
    pg.click("#cutBtn")
    pg.wait_for_timeout(3000)
    pg.eval_on_selector("#progressCard", "e => e.scrollIntoView({block:'center'})")
    pg.screenshot(path=f"{OUT}/02-progress.png")
    log("прогресс: " + pg.inner_text("#progressCount") + " · " + pg.inner_text("#progressNote"))
    pg.wait_for_selector("#results:not([hidden])", timeout=180000)
    pg.wait_for_timeout(1500)
    log("результат: " + pg.inner_text("#resultsTitle") + " / " + pg.inner_text("#resultsMeta"))
    log("карточек: " + str(pg.eval_on_selector_all(".card", "e => e.length")))
    log("размеры: " + str(pg.eval_on_selector_all(".card-sub", "e => e.map(x => x.textContent).slice(0,3)")))
    pg.eval_on_selector("#results", "e => e.scrollIntoView({block:'start'})")
    pg.screenshot(path=f"{OUT}/03-results.png")

    # 4. превью
    pg.click(".card .card-play")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{OUT}/04-modal.png")
    log("модалка: " + pg.inner_text("#modalTitle") + " | " + pg.inner_text("#modalMeta"))
    pg.keyboard.press("Escape")
    log("модалка закрыта: " + str(pg.eval_on_selector("#modal", "e => e.hidden")))

    # 5. перезагрузка — восстановление
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(1800)
    log("после reload: карточки=" + str(pg.eval_on_selector_all(".card", "e => e.length"))
        + " панель видна=" + str(pg.eval_on_selector("#panel", "e => !e.hidden"))
        + " заголовок='" + pg.inner_text("#resultsTitle") + "'")
    log("мета после reload: " + pg.inner_text("#resultsMeta"))
    log("readout после reload: " + pg.inner_text("#readout").replace("\n", " | "))
    pg.eval_on_selector("#panel", "e => e.scrollIntoView({block:'start'})")
    pg.screenshot(path=f"{OUT}/05-restored.png")

    # 6. скачивание одного куска и zip
    with pg.expect_download(timeout=60000) as dl:
        pg.click(".card-actions a")
    d = dl.value
    log("скачан кусок: " + d.suggested_filename)
    pg.click("#zipBtn")
    time.sleep(3)

    # 7. мобильный
    m = ctx.new_page()
    m.set_viewport_size({"width": 430, "height": 920})
    m.goto(BASE, wait_until="networkidle")
    m.wait_for_timeout(1500)
    m.screenshot(path=f"{OUT}/06-mobile.png", full_page=True)

    log("ошибки консоли: " + (str(errs[:6]) if errs else "нет"))
    log("провалившиеся запросы: " + (str(failed[:6]) if failed else "нет"))
    b.close()
print("ГОТОВО")
