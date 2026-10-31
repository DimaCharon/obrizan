"""Развёртка по всем вариациям: режем один клип всеми сочетаниями настроек.

Смысл не в том, чтобы «проверить что работает», а в том, чтобы получить таблицу
времени и размера для каждой комбинации — по ней видно, где качество стоит своих
денег, а где платишь временем зря.
"""
import json
import os
import subprocess
import sys
import time

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173"
SRC = sys.argv[2] if len(sys.argv) > 2 else "/home/user/testdata/клип 5 минут.mp4"
APP = os.path.dirname(os.path.abspath(__file__))
FP = subprocess.run(["node", "-e", "process.stdout.write(require('ffprobe-static').path)"],
                    cwd=APP, capture_output=True, text=True).stdout.strip()

rows = []


def curl(args, body=None):
    return subprocess.run(["curl", "-s", *args, *(["-d", body] if body else [])],
                          capture_output=True, text=True).stdout


def jpost(p, o):
    return json.loads(curl(["-X", "POST", f"{BASE}{p}", "-H", "Content-Type: application/json",
                            "-d", json.dumps(o)]) or "{}")


def jget(p):
    return json.loads(curl([f"{BASE}{p}"]) or "{}")


def upload(path, name):
    form = (f"--x\r\nContent-Disposition: form-data; name=\"video\"; filename=\"{name}\"\r\n"
            f"Content-Type: video/mp4\r\n\r\n").encode() + open(path, "rb").read() + b"\r\n--x--\r\n"
    tmp = "/tmp/_up.bin"
    open(tmp, "wb").write(form)
    out = subprocess.run(["curl", "-s", "-X", "POST", f"{BASE}/api/uploads",
                          "-H", "Content-Type: multipart/form-data; boundary=x",
                          "--data-binary", f"@{tmp}"], capture_output=True, text=True).stdout
    return json.loads(out)


meta = upload(SRC, "клип 5 минут.mp4")
print(f"источник: {meta['name']} · {meta['duration']}с · {meta['width']}x{meta['height']}\n")

CASES = [
    # (кусков, перехлёст, режим, улучшить, ×2)
    (2, 1, "fast", False, False),
    (2, 2, "accurate", False, False),
    (3, 0.5, "fast", False, False),
    (3, 1.5, "accurate", False, False),
    (5, 1, "fast", False, False),
    (5, 2, "accurate", True, False),
    (10, 1, "accurate", False, False),
    (10, 1.5, "fast", False, False),
    (10, 0.5, "accurate", True, True),
    (20, 2, "fast", False, False),
    (20, 1, "accurate", False, False),
    (40, 1.5, "fast", False, False),
    (40, 1, "accurate", False, False),
    (80, 1, "fast", False, False),
    (80, 0.5, "accurate", False, False),
    (4, 1, "accurate", True, True),
    (8, 2, "fast", True, False),
]

print(f"{'кусков':>6} {'перехл':>6} {'режим':>9} {'улуч':>5} {'×2':>3} {'время':>8} {'вес':>9}  статус")
print("-" * 68)

for pieces, overlap, mode, enh, ups in CASES:
    t0 = time.time()
    r = jpost("/api/cut", {"fileId": meta["fileId"], "pieces": pieces, "overlap": overlap,
                           "mode": mode, "enhance": enh, "upscale": ups})
    if not r.get("job"):
        rows.append((pieces, overlap, mode, enh, ups, None, None, "ОШИБКА " + str(r)[:40]))
        print(f"{pieces:>6} {overlap:>6} {mode:>9} {str(enh):>5} {str(ups):>3} {'—':>8} {'—':>9}  ОШИБКА {str(r)[:30]}")
        continue
    job = r["job"]
    while job["status"] in ("queued", "running"):
        time.sleep(0.6)
        job = jget(f"/api/jobs/{job['id']}").get("job", job)
    secs = time.time() - t0
    total = sum((x.get("size") or 0) for x in job["results"])
    # разрешение первого куска
    first = os.path.join(APP, "data/jobs", job["id"], "pieces", job["results"][0]["file"])
    dim = subprocess.run([FP, "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=width,height", "-of", "csv=p=0", first],
                         capture_output=True, text=True).stdout.strip() or "?"
    ok = job["status"] == "done" and all(x["status"] == "done" for x in job["results"])
    print(f"{pieces:>6} {overlap:>6} {mode:>9} {str(enh):>5} {str(ups):>3} "
          f"{secs:>7.1f}с {total/1048576:>8.1f}М  {'ok' if ok else 'СБОЙ'} {dim}")
    rows.append((pieces, overlap, mode, enh, ups, secs, total, job["status"]))
    # убираем за собой
    curl(["-X", "DELETE", f"{BASE}/api/jobs/{job['id']}"])

print()
fast = [r for r in rows if r[2] == "fast" and r[5]]
acc = [r for r in rows if r[2] == "accurate" and r[5]]
if fast and acc:
    print(f"быстро:  среднее {sum(r[5] for r in fast)/len(fast):.1f}с на прогон")
    print(f"точно:   среднее {sum(r[5] for r in acc)/len(acc):.1f}с на прогон")
broken = [r for r in rows if r[7] != "done"]
print(f"\nпрогонов {len(rows)}, сбоев {len(broken)}")
print("=== РАЗВЁРТКА: " + ("ПРОВАЛ" if broken else "ВСЁ ЗЕЛЁНОЕ") + " ===")
