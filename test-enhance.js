/* Проверка новых опций качества и улучшения через настоящий API */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');

const B = 'http://127.0.0.1:4173';
const FF = require('ffmpeg-static');
const FP = require('ffprobe-static').path;

const curl = (args, body) => spawnSync('curl', ['-s', ...args, ...(body ? ['-d', body] : [])], { encoding: 'utf8' }).stdout;
const jget = (p) => JSON.parse(curl([`${B}${p}`]) || '{}');
const jpost = (p, o) => JSON.parse(curl(['-X', 'POST', `${B}${p}`, '-H', 'Content-Type: application/json', '-d', JSON.stringify(o)]) || '{}');

const SRC = process.argv[2] || '/home/user/testdata/demo.mp4';
const NAME = encodeURIComponent('исходник.mp4');

// загрузка мультипартом через curl — так же, как браузер
const form = `--x\r\nContent-Disposition: form-data; name="video"; filename="${NAME}"\r\nContent-Type: video/mp4\r\n\r\n${fs.readFileSync(SRC).toString('binary')}\r\n--x--\r\n`;
fs.writeFileSync('/tmp/form.bin', Buffer.from(form, 'binary'));
const meta = JSON.parse(spawnSync('curl', ['-s', '-X', 'POST', `${B}/api/uploads`,
  '-H', 'Content-Type: multipart/form-data; boundary=x',
  '-H', `Content-Length: ${fs.statSync('/tmp/form.bin').size}`,
  '--data-binary', '@/tmp/form.bin'], { encoding: 'utf8' }).stdout);

console.log(`источник: ${meta.name} · ${meta.duration}с · ${meta.width}x${meta.height}\n`);

const cases = [
  ['точно (как было)', { mode: 'accurate' }],
  ['точно + улучшить', { mode: 'accurate', enhance: true }],
  ['точно + ×2', { mode: 'accurate', upscale: true }],
  ['точно + улучшить + ×2', { mode: 'accurate', enhance: true, upscale: true }],
  ['быстро + улучшить', { mode: 'fast', enhance: true }],
];

for (const [label, opts] of cases) {
  const t0 = Date.now();
  const r = jpost('/api/cut', { fileId: meta.fileId, pieces: 3, overlap: 1, ...opts });
  if (!r.job) { console.log(`${label}: ОШИБКА ${JSON.stringify(r).slice(0, 120)}`); continue; }
  let job = r.job;
  while (job.status === 'queued' || job.status === 'running') {
    spawnSync('sleep', ['0.7']);
    job = jget(`/api/jobs/${job.id}`).job;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const first = `/home/user/app/data/jobs/${job.id}/pieces/${job.results[0].file}`;
  const dim = execFileSync(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', first]).toString().trim();
  const sizes = job.results.map((x) => `${(x.size / 1024 / 1024).toFixed(2)}МБ`).join(' ');
  const note = job.results.some((x) => x.note) ? ` · ${job.results[0].note || ''}` : '';
  console.log(`${label.padEnd(24)} ${job.status} · ${secs}с · ${dim} · ${sizes}${note}`);
}
