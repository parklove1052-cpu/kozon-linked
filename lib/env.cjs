// 리포 맨 위의 .env 를 읽어 process.env 에 넣는다 (이미 있는 값은 덮지 않는다)
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, '.env');
for (const line of (fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
module.exports = { ROOT, FILE };
