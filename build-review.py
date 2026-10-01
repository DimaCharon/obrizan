import subprocess, os, json

APP = "/home/user/app"
FF = subprocess.check_output(["node", "-e", f"process.stdout.write(require('{APP}/node_modules/ffmpeg-static'))"]).decode()
SRC = sorted([f for f in os.listdir("/home/user/shots/review") if f.endswith(".webm")])[0]
SRC = f"/home/user/shots/review/{SRC}"
SEGDIR = "/home/user/shots/review/seg"
os.makedirs(SEGDIR, exist_ok=True)
for f in os.listdir(SEGDIR):
    os.remove(os.path.join(SEGDIR, f))

# карта записи (25 fps, 41.4 с):
#   герой 0–5 · панель 5–13 · таймлайн 13–22 · клик ~22.2 ·
#   прогресс 22.5–37.2 · результаты 37.2–40.3 · подвал 40.3–41.4
# монтаж выровнен по фразам озвучки (voice2.mp3, 9 фраз)
SCENES = [
    # (источник, длительность, что в кадре, доп. фильтры)
    (0.0,  3.4, "герой",              "fade=t=in:st=0:d=0.35"),
    (5.0,  2.6, "карточка источника", None),
    (6.6,  3.4, "куски",              None),
    (9.6,  3.4, "перехлёст",          None),
    (13.2, 7.0, "таймлайн",           None),
    (21.4, 1.4, "кнопка + клик",      None),
    (23.0, 2.4, "прогресс",           None),
    (37.2, 3.2, "результаты",         None),
    (39.0, 3.2, "итог + подвал",      "tpad=stop_mode=clone:stop_duration=2.0,fade=t=out:st=2.8:d=0.4"),
]

def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(" ".join(args[:6]) + "\n" + r.stderr[-600:])

parts = []
for i, (st, dur, label, extra) in enumerate(SCENES, 1):
    out = f"{SEGDIR}/s{i}.mp4"
    vf = "scale=1440:810"
    if extra:
        vf += "," + extra
    run([FF, "-y", "-v", "error", "-ss", f"{st}", "-i", SRC, "-an", "-t", f"{dur}",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
         "-pix_fmt", "yuv420p", "-r", "25", "-vf", vf, out])
    parts.append(out)
    print(f"сцена {i} · {label:<18} src {st:>5}s +{dur}s · {os.path.getsize(out)/1024:.0f} КБ")

lst = f"{SEGDIR}/list.txt"
with open(lst, "w") as fh:
    for p in parts:
        fh.write(f"file '{os.path.basename(p)}'\n")
combined = f"{SEGDIR}/combined.mp4"
run([FF, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", combined])

final = "/home/user/shots/review/narezatko-review.mp4"
run([FF, "-y", "-v", "error", "-i", combined, "-i", "/home/user/shots/review/voice2.mp3",
     "-map", "0:v", "-map", "1:a",
     "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
     "-af", "afade=t=in:st=0:d=0.2,afade=t=out:st=27.8:d=0.4",
     "-movflags", "+faststart", final])

FP = f"{APP}/node_modules/ffprobe-static/bin/linux/x64/ffprobe"
info = json.loads(subprocess.check_output(
    [FP, "-v", "error", "-show_entries", "format=duration,size", "-of", "json", final]).decode())["format"]
print(f"\nитог: {final}")
print(f"длительность: {float(info['duration']):.1f}с · размер: {int(info['size'])/1024/1024:.1f} МБ")
