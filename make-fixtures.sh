#!/usr/bin/env bash
# Создаёт тестовые видео, если их нет.
#
#   ./make-fixtures.sh            # demo + test + кириллица 42 МБ
#   ./make-fixtures.sh --with-40  # плюс файл на 40 минут (90 МБ)
#
# Фикстуры не хранятся в репозитории и не должны копиться в снимке рабочей
# папки: снимок ограничен примерно 128 МБ, и большой мусор вытесняет оттуда
# data/ — то есть загруженные пользователем видео и результаты нарезки.
# Поэтому файлы генерируются на месте, а не живут постоянно.

set -e
cd "$(dirname "$0")"
DIR="${FIXTURE_DIR:-/home/user/testdata}"
mkdir -p "$DIR"

FF="$(node -e "process.stdout.write(require('ffmpeg-static'))")"

# демо: 60 c, 640x360, со звуком
[ -f "$DIR/demo.mp4" ] || "$FF" -y -v error \
  -f lavfi -i "testsrc2=size=640x360:rate=25" \
  -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 60 \
  -c:v libx264 -preset veryfast -b:v 400k -pix_fmt yuv420p \
  -c:a aac -b:a 64k -movflags +faststart "$DIR/demo.mp4"

# короткое кириллическое имя — для проверки кодировки имени
[ -f "$DIR/Звонок с клиентом — короткий.mp4" ] || "$FF" -y -v error \
  -f lavfi -i "testsrc2=size=640x360:rate=25" -t 20 \
  -c:v libx264 -preset veryfast -b:v 400k -pix_fmt yuv420p \
  -movflags +faststart "$DIR/Звонок с клиентом — короткий.mp4"

# Средний файл с кириллицей в имени — основной для браузерных тестов.
# 17 МБ хватает с запасом: порог чанковой загрузки 4 МБ, значит кусков будет
# несколько и путь с кусками реально проверяется. Держим маленьким специально:
# снимок рабочей папки ограничен ~128 МБ.
[ -f "$DIR/Звонок с клиентом — 12 сентября.mp4" ] || "$FF" -y -v error \
  -f lavfi -i "testsrc2=size=1280x720:rate=25" \
  -f lavfi -i "sine=frequency=330:sample_rate=44100" -t 200 \
  -c:v libx264 -preset veryfast -b:v 600k -maxrate 650k -bufsize 1200k -pix_fmt yuv420p \
  -c:a aac -b:a 96k -movflags +faststart "$DIR/Звонок с клиентом — 12 сентября.mp4"

# test-api.js проверяет недосланный кусок: файл должен быть крупнее двух
# кусков по 4 МБ, иначе пропускать нечего и тест перестаёт что-либо проверять
[ -f "$DIR/test.mp4" ] || "$FF" -y -v error \
  -f lavfi -i "testsrc2=size=640x360:rate=25" \
  -f lavfi -i "sine=frequency=500:sample_rate=44100" -t 90 \
  -c:v libx264 -preset veryfast -b:v 1000k -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart "$DIR/test.mp4"

if [ "${1:-}" = "--with-40" ]; then
  # 40 минут: то, на котором пользователь ловил ошибки
  [ -f "$DIR/Вебинар — запись, 40 минут.mp4" ] || "$FF" -y -v error \
    -f lavfi -i "testsrc2=size=640x360:rate=25" \
    -f lavfi -i "sine=frequency=300:sample_rate=44100" -t 2400 \
    -c:v libx264 -preset veryfast -b:v 260k -maxrate 300k -bufsize 600k -pix_fmt yuv420p \
    -c:a aac -b:a 48k -movflags +faststart "$DIR/Вебинар — запись, 40 минут.mp4"
fi

echo "фикстуры в $DIR:"
ls -la "$DIR" | awk 'NR>3 {printf "  %8.1f МБ  %s\n", $5/1048576, $9}'
