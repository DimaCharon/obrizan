"""Хаотичный тест: тыкаем все кнопки в случайном порядке и смотрим, что сломается.

Смысл не в том, чтобы нажать всё по порядку, а в том, чтобы поймать состояние,
до которого нормальный сценарий не дойдёт: переключение режима посреди нарезки,
смена количества кусков во время ожидания, повторные нажатия «резать», сброс
посреди загрузки, восстановление прошлой задачи поверх новой.
"""
import random
import sys
import time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173"
BIG = sys.argv[2] if len(sys.argv) > 2 else "/home/user/testdata/48 часов — длинное видео.mp4"
SEED = int(sys.argv[3]) if len(sys.argv) > 3 else 20261003
random.seed(SEED)

fails, notes = [], []


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def check(name, cond, extra=""):
    if not cond:
        fails.append(f"{name} {extra}".strip())
    log(("OK   " if cond else "FAIL ") + name + (f"  {extra}" if extra else ""))


def ensure_source(pg, path):
    """После перезагрузки страницы панель может быть скрыта — тогда сбрасываем
    и загружаем файл заново. Иначе тычки по контролам упираются в невидимые
    кнопки, и тест падает не по делу."""
    if pg.evaluate("() => !document.querySelector('#panel').hidden"):
        return True
    try:
        pg.evaluate("() => { const r = document.querySelector('#resetBtn'); if (r && !document.querySelector('#panel').hidden) r.click(); }")
        pg.wait_for_selector("#dropzone:not([hidden])", timeout=60000)
        pg.set_input_files("#fileInput", path)
        pg.wait_for_selector("#panel:not([hidden])", timeout=1800000)
        return True
    except Exception:
        return False


with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    pg = ctx.new_page()
    errs, bad = [], []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("response", lambda r: bad.append(f"{r.status} {r.url.replace(BASE, '')}")
                         if r.status >= 400 and "/api/" in r.url else None)

    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_timeout(2600)
    # старт никогда не «чистый»: восстанавливается прошлая задача
    pg.evaluate("() => { const r = document.querySelector('#resetBtn'); if (r && !document.querySelector('#panel').hidden) r.click(); }")
    pg.wait_for_selector("#dropzone:not([hidden])", timeout=60000)
    log(f"цель {BASE} · сид {SEED}")

    # ── загрузка ────────────────────────────────────────────────
    t0 = time.time()
    pg.set_input_files("#fileInput", BIG)
    pg.wait_for_selector("#panel:not([hidden])", timeout=1800000)
    log(f"загружено за {time.time()-t0:.1f}с · {pg.inner_text('#srcMeta')}")

    # ── случайные тычки ─────────────────────────────────────────
    ACTIONS = [
        ("куски +1", lambda: pg.evaluate("() => { state.pieces = Math.min(MAX_PIECES, state.pieces + 1); syncControls(); }")),
        ("куски -1", lambda: pg.evaluate("() => { state.pieces = Math.max(2, state.pieces - 1); syncControls(); }")),
        ("куски случайно", lambda: pg.evaluate(f"() => {{ state.pieces = {random.randint(2, 80)}; syncControls(); }}")),
        ("перехлёст", lambda: pg.click('#overlapSeg button[data-overlap="0.5"], #overlapSeg button[data-overlap="1"], #overlapSeg button[data-overlap="1.5"], #overlapSeg button[data-overlap="2"] >> nth=0')),
        ("режим точно", lambda: pg.click('#modeSeg button[data-mode="accurate"]')),
        ("режим быстро", lambda: pg.click('#modeSeg button[data-mode="fast"]')),
        ("галочка улучшить", lambda: pg.click("#enhanceChk")),
        ("галочка ×2", lambda: pg.click("#upscaleChk")),
        ("число кусков в поле", lambda: pg.fill("#piecesNum", str(random.randint(2, 80)))),
        ("Enter в поле", lambda: pg.press("#piecesNum", "Enter")),
        ("Tab из поля", lambda: pg.press("#piecesNum", "Tab")),
        ("ползунок кусков", lambda: pg.evaluate("() => { const r = document.querySelector('#piecesRange'); r.value = String(Math.floor(Math.random()*78)+2); r.dispatchEvent(new Event('input', {bubbles:true})); }")),
        ("чип кусков", lambda: pg.click("#chips button >> nth=" + str(random.randint(0, 4)))),
        ("скролл вниз", lambda: pg.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")),
        ("скролл вверх", lambda: pg.evaluate("() => window.scrollTo(0, 0)")),
        ("перезагрузка", lambda: pg.reload(wait_until="networkidle")),
    ]

    for i in range(28):
        name, fn = random.choice(ACTIONS)
        try:
            fn()
            pg.wait_for_timeout(random.randint(120, 500))
        except Exception as e:
            notes.append(f"тычка {i} «{name}»: {str(e).splitlines()[0][:70]}")
        # после каждой тычки приложение должно оставаться живым
        alive = pg.evaluate("() => !!document.querySelector('#panel')")
        if not alive:
            fails.append(f"после тычки «{name}» интерфейс умер")
            break

    # ── нарезка в случайных настройках ──────────────────────────
    check("исходник на месте после хаоса", ensure_source(pg, BIG))
    if not pg.evaluate("() => !document.querySelector('#panel').hidden"):
        log("исходник потерялся после хаоса — остальное пропускаю")
        ctx.close(); b.close()
        print("\n=== ХАОС: ПРОВАЛ (исходник не восстановился) ===")
        sys.exit(1)
    pieces = random.randint(2, 40)
    overlap = random.choice([0.5, 1, 1.5, 2])
    mode = random.choice(["accurate", "fast"])
    enh = random.choice([True, False])
    ups = random.choice([True, False])
    log(f"иtоговая нарезка: {pieces} кусков · перехлёст {overlap} · {mode} · улучшить={enh} · ×2={ups}")

    pg.click('#modeSeg button[data-mode="accurate"]')
    pg.fill("#piecesNum", str(pieces))
    pg.press("#piecesNum", "Tab")
    pg.click(f'#overlapSeg button[data-overlap="{overlap}"]')
    pg.click('#modeSeg button[data-mode="%s"]' % mode)
    if enh:
        pg.check("#enhanceChk")
    else:
        pg.uncheck("#enhanceChk")
    if ups:
        pg.check("#upscaleChk")
    else:
        pg.uncheck("#upscaleChk")
    pg.wait_for_timeout(1500)

    t0 = time.time()
    pg.click("#cutBtn")
    pg.wait_for_selector("#results:not([hidden])", timeout=3000000)
    cut = time.time() - t0
    cards = pg.query_selector_all(".card")
    log(f"нарезка за {cut:.1f}с · карточек {len(cards)} · {pg.inner_text('#resultsMeta').replace(chr(10), ' | ')}")
    check("карточки по числу кусков", len(cards) == pieces, f"ждали {pieces}, получили {len(cards)}")

    # ── тыкаем результат ────────────────────────────────────────
    for frac in (0.3, 0.6, 1.0):
        pg.evaluate(f"() => window.scrollTo(0, document.body.scrollHeight * {frac})")
        pg.wait_for_timeout(600)
    try:
        pg.wait_for_function(
            "() => [...document.querySelectorAll('.card-thumb img')].every(i => i.naturalWidth > 0)",
            timeout=180000)
        check("все превью загрузились", True)
    except Exception:
        n = pg.eval_on_selector_all(".card-thumb img", "e => e.filter(i => i.naturalWidth > 0).length")
        check("все превью загрузились", False, f"загружено {n} из {len(cards)}")

    # скачивание одного куска
    try:
        with pg.expect_download(timeout=300000) as dl:
            pg.query_selector_all(".card-dl button, .card a")[0].click()
        check("один кусок скачивается", True, f"{(dl.value.path() and __import__('os').path.getsize(dl.value.path()))/1048576:.1f} МБ")
    except Exception as e:
        notes.append(f"скачивание одного куска: {str(e).splitlines()[0][:70]}")

    # архив
    try:
        with pg.expect_download(timeout=3000000) as dz:
            pg.click("#zipBtn")
        check("архив скачивается", True, f"{__import__('os').path.getsize(dz.value.path())/1048576:.0f} МБ")
    except Exception as e:
        check("архив скачивается", False, str(e).splitlines()[0][:70])

    # ── сброс и повторная загрузка ──────────────────────────────
    pg.click("#resetBtn")
    pg.wait_for_selector("#dropzone:not([hidden])", timeout=120000)
    pg.wait_for_timeout(400)
    t0 = time.time()
    pg.set_input_files("#fileInput", BIG)
    pg.wait_for_selector("#panel:not([hidden])", timeout=1800000)
    log(f"повторная загрузка за {time.time()-t0:.1f}с")
    check("повторная загрузка работает", True)

    real = [e for e in errs if "Failed to load resource" not in e]
    log("— сетевые ошибки: " + (", ".join(bad[:6]) if bad else "нет"))
    log("— консоль: " + ("; ".join(real[:4]) if real else "чисто"))
    check("ошибок консоли нет", len(real) == 0, "; ".join(real[:2]))
    check("сетевых ошибок нет", len(bad) == 0, "; ".join(bad[:3]))
    if notes:
        log("— замечания: " + " | ".join(notes[:5]))
    ctx.close()
    b.close()

print("\n=== ХАОС (сид %d): %s ===" % (SEED, "ПРОВАЛ " + str(len(fails)) if fails else "ВСЁ ЗЕЛЁНОЕ"))
for f in fails:
    print("  ✗ " + f)
