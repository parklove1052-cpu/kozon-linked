// 상태 표시를 이 PC 의 Claude Code·VS Code 설정에 넣는다 (여러 번 돌려도 같다)
//   node status/apply_settings.cjs          넣기
//   node status/apply_settings.cjs --dry    무엇이 바뀔지만 보기
// ① 탭 점: 🔴 작업 중 · 🟡 에이전트만 도는 중 · 🟢 끝/봐줄 때  (훅 6개 → status/dot.cjs)
// ② 아래 파란 상태줄: 방 이름 · 모델  (status/statusline.ps1)
// ③ VS Code 터미널 탭 이름 = 위 점 + 방 이름  (terminal.integrated.tabs.title = ${sequence})
// 고치기 전 원본은 같은 폴더에 .bak_<날짜> 로 남긴다.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DRY = process.argv.includes('--dry');
const HERE = __dirname;
const DOT = path.join(HERE, 'dot.cjs');
const LINE = path.join(HERE, 'statusline.ps1');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

function load(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try { return JSON.parse(raw || '{}'); }
  catch { return null; }   // 주석이 든 JSON 등 — 건드리지 않는다
}
function save(file, obj) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak_${stamp}`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ── ① ② Claude Code 설정 ──
const CC = path.join(os.homedir(), '.claude', 'settings.json');
const s = load(CC);
if (!s) { console.error(`🛑 ${CC} 를 읽지 못했습니다(JSON 오류). 손으로 고친 뒤 다시 돌려 주세요.`); process.exit(1); }
s.hooks = s.hooks || {};
const EVENTS = { UserPromptSubmit: 'working', Notification: 'need', Stop: 'done', SubagentStart: 'agent_start', SubagentStop: 'agent_stop', SessionStart: 'start' };
for (const [ev, arg] of Object.entries(EVENTS)) {
  // 예전 dot.cjs 훅(어느 경로든)은 빼고 이 리포 것 하나만 둔다
  const keep = (s.hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !/dot\.cjs/i.test(h.command || '')) }))
    .filter((g) => g.hooks.length);
  keep.push({ hooks: [{ type: 'command', command: `node "${DOT}" ${arg}` }] });
  s.hooks[ev] = keep;
}
const oldLine = s.statusLine && s.statusLine.command;
if (oldLine && !/statusline\.ps1/i.test(oldLine)) console.log(`※ 쓰던 상태줄을 바꿉니다 (원본은 .bak 에): ${oldLine}`);
// 도메인메이커(scripts\statusline.ps1 + domain-config.json)를 이미 쓰는 PC 면 그쪽을 그대로 둔다
if (!(oldLine && /domain|코존워크스페이스/i.test(oldLine))) {
  s.statusLine = { type: 'command', command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${LINE}"` };
}
s.env = { ...(s.env || {}), CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' };   // Claude 가 탭 이름을 덮어쓰지 않게
save(CC, s);
console.log(`${DRY ? '[미리보기] ' : ''}✅ Claude Code 설정: 훅 6개 · 상태줄 · 탭 이름 고정 → ${CC}`);

// ── ③ VS Code 탭 이름 ──
const VS = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
if (!fs.existsSync(path.dirname(VS))) console.log('※ VS Code 가 없어 탭 이름 설정은 건너뜁니다 (윈도우 터미널이면 그대로 창 제목에 뜹니다)');
else {
  const v = load(VS);
  if (!v) console.log(`※ ${VS} 에 주석이 있어 손대지 않았습니다 → 직접 넣으세요:  "terminal.integrated.tabs.title": "\${sequence}"`);
  else if (v['terminal.integrated.tabs.title'] === '${sequence}') console.log('✅ VS Code 탭 이름: 이미 되어 있음');
  else { v['terminal.integrated.tabs.title'] = '${sequence}'; save(VS, v); console.log(`${DRY ? '[미리보기] ' : ''}✅ VS Code 탭 이름 설정 → ${VS}`); }
}
console.log('→ 열려 있는 Claude 창은 한 번 닫았다 다시 열어야 적용됩니다.');
