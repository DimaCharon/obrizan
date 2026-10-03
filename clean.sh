#!/usr/bin/env bash
# Убирает из data/ то, что оставили тесты и старые запуски.
#
#   ./clean.sh           # убрать всё, кроме данных живого сервера
#   ./clean.sh --all     # убрать вообще всё
#
# Зачем: снимок рабочей папки ограничен примерно 128 МБ. Если data/ распухнет
# от тестовых исходников и нарезок, он целиком выпадает из снимка — и тогда
# загруженное пользователем видео пропадает между запусками, а нарезка падает
# с «сервер перезапустился и потерял временные файлы». Держим data/ маленьким.

set -e
cd "$(dirname "$0")"

if [ "${1:-}" = "--all" ]; then
  rm -rf data
  echo "data/ удалена полностью"
  exit 0
fi

before=$(du -sh data 2>/dev/null | cut -f1)

# исходники и задачи, созданные автотестами (имена начинаются с этих префиксов)
for d in data/uploads/*/; do
  [ -d "$d" ] || continue
  base=$(basename "$d")
  case "$base" in
    chunk*|test*|api*|notvideo*) rm -rf "$d" ;;
  esac
done
# Результаты нарезки — производные: если пропали, их можно нарезать заново.
# Исходники, наоборот, дороги: пользователю пришлось бы загружать видео снова.
# Поэтому чистим задачи, а исходники бережём.
#
# Задача без своего исходника — однозначно мусор: перерезать её нечем, а в
# интерфейсе она всё равно покажется как «файлы ещё на диске». Это правило
# ловит и то, что оставляют автотесты, и то, что остаётся от прошлых запусков,
# не трогая живую работу пользователя.
for d in data/jobs/*/; do
  [ -d "$d" ] || continue
  st="$d/status.json"
  [ -f "$st" ] || { rm -rf "$d"; continue; }
  fid=$(node -e "try{process.stdout.write(require('$PWD/$st').fileId||'')}catch(e){}" 2>/dev/null)
  if [ -z "$fid" ] || [ ! -d "data/uploads/$fid" ]; then
    rm -rf "$d"
  fi
done

# мусор от прогонов тестов
rm -f /home/user/testdata/out.zip /home/user/testdata/*.mp4.tmp 2>/dev/null || true

after=$(du -sh data 2>/dev/null | cut -f1)
echo "data/: ${before:-0} → ${after:-0}"
du -sh --exclude=node_modules --exclude=.npm /home/user 2>/dev/null | tail -1 | sed 's/^/вся папка: /'
