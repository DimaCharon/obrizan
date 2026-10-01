import time
from playwright.sync_api import sync_playwright

W, H = 1440, 810
OUT = "/home/user/shots/review"

def wait(ms):
    time.sleep(ms / 1000)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    ctx = b.new_context(
        viewport={"width": W, "height": H},
        record_video_dir=OUT,
        record_video_size={"width": W, "height": H},
    )
    pg = ctx.new_page()
    pg.goto("http://127.0.0.1:4173/", wait_until="networkidle")
    wait(2600)                                   # герой

    pg.mouse.move(330, 660, steps=25)            # к кнопке «Выбрать видео»
    wait(900)

    pg.set_input_files("#fileInput", "/home/user/testdata/demo.mp4")
    pg.wait_for_selector("#panel:not([hidden])", timeout=60000)
    wait(1900)                                   # карточка источника

    pg.mouse.move(300, 560, steps=18)            # к полю «кусков»
    wait(700)
    pg.fill("#piecesNum", "6")
    pg.press("#piecesNum", "Tab")
    wait(900)

    pg.mouse.move(300, 660, steps=20)            # к чипам
    wait(1100)
    pg.mouse.move(880, 640, steps=25)            # к перехлёсту
    wait(1100)
    pg.mouse.move(1180, 640, steps=20)           # к режиму
    wait(900)

    pg.evaluate("document.querySelector('.timeline-wrap').scrollIntoView({block:'center', behavior:'smooth'})")
    wait(1400)
    for x in (500, 700, 900, 1100, 1300):        # пройтись по кускам таймлайна
        pg.mouse.move(x, 700, steps=30)
        wait(650)

    pg.mouse.move(720, 300, steps=25)            # к планкам и кнопке
    wait(1200)
    pg.evaluate("document.querySelector('#cutBtn').scrollIntoView({block:'center', behavior:'smooth'})")
    wait(900)
    pg.mouse.move(720, 480, steps=20)
    wait(700)

    pg.click("#cutBtn")                          # резка
    wait(7600)

    pg.evaluate("window.scrollTo({top: document.body.scrollHeight, behavior:'smooth'})")
    wait(1200)
    pg.mouse.move(400, 500, steps=25)
    wait(900)
    pg.evaluate("document.querySelector('#results').scrollIntoView({block:'start', behavior:'smooth'})")
    wait(1500)
    pg.mouse.move(700, 520, steps=25)
    wait(900)

    pg.evaluate("window.scrollTo({top: document.body.scrollHeight, behavior:'smooth'})")
    wait(2200)

    ctx.close()
    b.close()
print("запись готова")
