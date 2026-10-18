// 터미널 탭에 상태 도트 찍기
//   node status/dot.cjs working|need|done|start|agent_start|agent_stop [방이름]
// 🛑 VS코드 설정 terminal.integrated.tabs.title = "${sequence}" 라서 탭 이름에 그대로 뜬다.
// 🛑 훅에서 부르면 stdout 이 Claude 에게 잡혀 터미널에 안 닿을 수 있어 CONOUT$ 에도 쓴다.
const fs = require('fs'), path = require('path');
const DATA = path.join(__dirname, '..', 'data');   // 리포 data 폴더 (안 올라감)
const LOG = path.join(DATA, 'dot.log');

let state = (process.argv[2] || 'done').toLowerCase();
const DOT = { working: '🔴', agent: '🟡', need: '🟢', done: '🟢' };  // 10-18 사장님: 작업 중=빨강, 에이전트만 도는 중=노랑, 봐줄 때·끝=초록

// 훅이 stdin 으로 주는 JSON (session_id · agent_id …). 손으로 돌리면 없음.
let hook = {};
if (!process.stdin.isTTY) { try { hook = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {} }

// 에이전트 감지 (10-18) — 세션마다 돌고 있는 에이전트 번호를 파일에 적는다
//   agent_start / agent_stop = SubagentStart / SubagentStop 훅 · start = SessionStart 훅(묵은 기록 비움)
// 🛑 본 대화가 끝나도(Stop) 에이전트가 돌고 있으면 🔴 그대로 둔다
const sid = String(hook.session_id || 'nosession').replace(/[^\w-]/g, '');
const stFile = path.join(DATA, 'dot_state', sid + '.json');
let st = { agents: [], mainDone: false };
try { st = Object.assign(st, JSON.parse(fs.readFileSync(stFile, 'utf8'))); } catch {}
const aid = String(hook.agent_id || hook.agent_type || 'agent');
if (state === 'start') {
  st = { agents: [], mainDone: true }; state = 'done';
  // 이틀 지난 세션 기록은 지운다
  try { for (const f of fs.readdirSync(path.dirname(stFile))) {
    const fp = path.join(path.dirname(stFile), f);
    if (Date.now() - fs.statSync(fp).mtimeMs > 2 * 864e5) fs.unlinkSync(fp);
  } } catch {}
}
else if (state === 'agent_start') { if (!st.agents.includes(aid)) st.agents.push(aid); }
else if (state === 'agent_stop') { st.agents = st.agents.filter(a => a !== aid); }
else if (state === 'working') st.mainDone = false;
else if (state === 'done' || state === 'need') st.mainDone = true;
if (hook.session_id) {
  try { fs.mkdirSync(path.dirname(stFile), { recursive: true }); fs.writeFileSync(stFile, JSON.stringify(st)); } catch {}
}
// 🔴 본 대화 작업 중 · 🟡 본 대화는 끝났는데 에이전트가 도는 중 · 🟢 끝/봐줄 때 (10-18 사장님)
let dot = state === 'need' ? DOT.need
  : !st.mainDone ? DOT.working
  : st.agents.length ? DOT.agent
  : DOT.done;

let room = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3] : null;
if (!room) {
  // 🛑 Claude 를 연 폴더(CLAUDE_PROJECT_DIR) 기준 — 작업 중 cd 해도 방 이름이 안 바뀐다 (10-18)
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // …\domains\<방이름>\… 에서 방 이름을 뽑는다 (윈도우 역슬래시·슬래시 둘 다)
  // 🛑 방 안쪽 깊은 폴더(projects\… 등)에서 돌아도 «방» 이름이 나와야 한다
  const m = cwd.match(/[\\/]domains[\\/]([^\\/]+)/);
  room = m ? m[1] : (path.basename(cwd) || cwd);
}

const label = dot + ' ' + room + (st.agents.length ? ' · 에이전트 ' + st.agents.length : '');
const seq = '\u001b]0;' + label + '\u0007';

// ① 보통 출력 — 손으로 돌릴 때만 (훅에서는 이 글자가 Claude 대화에 섞여 들어감)
if (process.stdout.isTTY) { try { process.stdout.write(seq); } catch {} }
// ② 콘솔 장치에 직접 (훅에서 불릴 때)
// 🛑 '\\\\.\\CONOUT$' 로 써야 진짜 콘솔이다 ('\\.\CONOUT$' 는 C:\.CONOUT$ 파일이 돼 버림 — 10-18 고침)
try { fs.writeFileSync('\\\\.\\CONOUT$', seq); }
catch (e) { try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LOG, '  CONOUT 실패: ' + e.message + '\n'); } catch {} }

// ③ 훅은 숨은 콘솔에서 돌아 ①② 가 탭에 안 닿는다 → claude.exe 콘솔에 붙어 제목을 바꾼다 (10-18)
try {
  require('child_process').spawnSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'set_title.ps1'), label],
    { stdio: 'ignore', timeout: 5000 });
} catch {}

// 기록 — 훅이 실제로 돌았는지 확인용
try {
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(LOG,
    new Date().toISOString().slice(0,19).replace('T',' ') + '  ' + state + '  ' + label + '  (' + process.cwd() + ')\n');
} catch {}

if (process.argv.includes('--v')) console.error('[dot] ' + state + ' → ' + label);
