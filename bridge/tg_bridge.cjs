#!/usr/bin/env node
// 📱 텔레그램 ↔ 헤드쿼터스 브릿지
//   폰에서 봇에게 보낸 글을 이 PC 의 Claude Code 가 받아 실행하고, 결과를 다시 보낸다.
//
//   실행:  bridge\start_bridge.cmd   (또는 npm run bridge)
//   끄기:  그 창을 닫는다
//
// 🛑 이 브릿지는 «사장님 chat_id» 에서 온 글만 실행한다. 그 외는 통째로 무시한다.
// 🛑 권한은 bypass 로 돈다 — 밖에서 승인 버튼을 누를 사람이 없기 때문이다.
//    그래서 발신자 검증이 유일한 방어선이다. 토큰이 새면 이 PC 가 열린다.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ROOT } = require('../lib/env.cjs');   // 리포 맨 위 .env 를 읽는다
// Claude 가 일하는 폴더(= 헤드쿼터스). .env 의 WORK_DIR, 없으면 리포 안 workspace 폴더
const HQ = path.resolve(process.env.WORK_DIR || path.join(ROOT, 'workspace'));
fs.mkdirSync(HQ, { recursive: true });
const DATA = path.join(ROOT, 'data');        // 브릿지 상태 파일·기록·받은 파일
fs.mkdirSync(DATA, { recursive: true });
const STATE = path.join(DATA, '.tg_bridge_offset');
const CLAUDE = process.env.CLAUDE_EXE || path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');   // PC 마다 사용자 폴더가 다르다
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const SLOW_NOTICE_MS = 15 * 60 * 1000;   // 이만큼 지나면 «걸어두고 있습니다» 만 알린다 (끊지 않는다)
const HARD_LIMIT_MS = 3 * 60 * 60 * 1000; // ponytail: 3시간 절대 상한. 이걸 넘기면 멈춘 것으로 본다
// 브릿지 전용 봇(@Headlinkbot)을 쓴다. 알림봇과 섞지 않는다 — 사고가 나도 알림은 살아 있어야 한다.
const TOKEN = process.env.HQ_TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const OWNER = String(process.env.TELEGRAM_CHAT_ID || '');
if (!process.argv.includes('--selftest') && (!TOKEN || !OWNER)) { console.error('🛑 .env 에 HQ_TG_BOT_TOKEN / TELEGRAM_CHAT_ID 가 필요합니다'); process.exit(1); }

// 📝 기록 (2026-10-08): 창에 찍히는 글을 tg_bridge.log 에도 남긴다 — «왜 안 됐는지» 를 나중에 볼 수 있게.
const LOG = path.join(DATA, 'tg_bridge.log');
for (const k of ['log', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    orig(...a);
    try {
      if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2e6) fs.renameSync(LOG, LOG + '.old');
      fs.appendFileSync(LOG, `${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')} ${a.join(' ')}\n`);
    } catch { /* noop */ }
  };
}

// 🛑 시간 제한(2026-10-08): 절전에서 깨어나거나 인터넷이 잠깐 끊기면 응답 없는 연결을 영원히 기다린다 → 60초에 끊고 다시 묻는다.
const api = (m, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  signal: AbortSignal.timeout(60000),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

async function say(text) {
  // 텔레그램 한 통 4096자 — 넉넉히 3500 으로 자른다
  for (let i = 0; i < text.length; i += 3500) {
    const r = await api('sendMessage', { chat_id: OWNER, text: text.slice(i, i + 3500), disable_web_page_preview: true });
    if (!r.ok) console.error('[전송 실패]', JSON.stringify(r).slice(0, 160));
  }
}

// 🧠 대화 이어가기 (2026-09-16): 예전엔 --continue 였는데, 그건 «이 폴더의 가장 최근 대화» 를 잇는다.
//    헤드쿼터스 폴더는 PC 터미널 세션도 같이 쓰므로 폰 대화가 엉뚱한 대화에 붙어 기억이 끊겼다.
//    → 브릿지 전용 session_id 를 파일에 저장해 두고 --resume <id> 로 정확히 그 대화만 잇는다.
const SESSION = path.join(DATA, '.tg_bridge_session');
const readSession = () => { try { return fs.readFileSync(SESSION, 'utf8').trim(); } catch { return ''; } };
const saveSession = (id) => { try { if (id) fs.writeFileSync(SESSION, id); else fs.rmSync(SESSION, { force: true }); } catch { /* noop */ } };

// claude -p --output-format json 출력 → { ok, text, sid }. JSON 이 아니면(강제종료 등) 그대로 돌려준다.
function parseResult(out, code) {
  try {
    const j = JSON.parse(String(out).trim().split(/\r?\n/).pop());
    return { ok: code === 0 && !j.is_error, text: String(j.result || '').trim(), sid: j.session_id || '' };
  } catch { return { ok: false, text: String(out || '').trim(), sid: '' }; }
}

// Claude Code 를 한 번 돌린다. 프롬프트는 stdin 으로 넣어 따옴표 사고를 막는다.
// 🕗 오래 걸리는 일은 «끊지 않고 걸어둔다» — 15분에 한 번 알리고, 끝나면 결과를 보낸다.
// 🛑 /취소 (2026-10-08 사장님): 돌고 있는 Claude 를 «그 자리에서» 끊는다. 되돌리지 않는다 — 한 데까지는 남는다.
let current = null;      // 지금 돌고 있는 claude 프로세스
let gen = 0;             // /취소 때마다 1 오른다 — 그 전에 줄 선 작업은 번호가 달라 건너뛴다
// ── /할일 (2026-10-10 사장님): 칠판을 폰에서 바로 본다. Claude 를 거치지 않는다 ──
// 할 일 판(todo.cjs)이 있으면 .env 의 TODO_JS 에 경로를 적는다. 없으면 /할일 은 «없음» 으로 답한다
const TODO_JS = process.env.TODO_JS || '';
let addWaitAt = 0;                 // 「/할일 추가」 를 누른 시각 (3분 안에 온 글을 제목으로 쓴다)
const ADD_WINDOW_MS = 3 * 60000;
function todoLines() {             // 칠판 정본을 그대로 읽어 온다
  if (!TODO_JS) throw new Error('이 PC 에는 할 일 판이 설치되지 않았습니다 (.env TODO_JS)');
  delete require.cache[require.resolve(TODO_JS)];
  const T = require(TODO_JS);
  const d = T.load();
  const order = ["confirm", "propose", "doing", "todo", "check", "wait", "later"];
  const items = d.items.filter((x) => x.status !== "done" && x.status !== "gone")
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.id - b.id);
  return { d, items, T };
}

let interrupted = false; // 방금 끊었다 — 다음 글 앞에 그 사실을 알려 준다
// claude 가 띄운 배치·브라우저 스크립트까지 같이 끊어야 한다 → 프로세스 트리째(/T) 죽인다
function killTree(p) {
  try { require('node:child_process').execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); return true; }
  catch { try { return p.kill(); } catch { return false; } }
}
function killCurrent() {
  if (!current) return false;
  interrupted = true;
  return killTree(current);
}

function runClaude(prompt, { fresh = false, onSlow = () => {} } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', MODEL, '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--chrome'];
    let sid = fresh ? '' : readSession();
    if (sid) args.push('--resume', sid);
    else {
      // 새 대화는 번호를 미리 정해 저장한다 — 첫 일을 /취소 로 끊어도 다음 글이 그 대화에 이어진다
      sid = require('node:crypto').randomUUID();
      args.push('--session-id', sid);
      saveSession(sid);
      sid = '';
    }
    const p = spawn(CLAUDE, args, { cwd: HQ, windowsHide: true });
    current = p;                       // /취소 가 끊을 수 있게 들고 있는다
    let out = '', err = '';
    const slow = setInterval(() => onSlow(), SLOW_NOTICE_MS);
    const hard = setTimeout(() => { killTree(p); }, HARD_LIMIT_MS);
    const done = (v) => { clearInterval(slow); clearTimeout(hard); resolve(v); };
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { if (current === p) current = null; done({ ok: false, out, err: String(e.message) }); });
    p.on('close', (code) => {
      if (current === p) current = null;
      const r = parseResult(out, code);
      if (r.sid) saveSession(r.sid);
      done({ ok: r.ok, out: r.text, err: err.trim(), code, resumed: !!sid });
    });
    p.stdin.end(prompt, 'utf8');
  });
}

// 🖼 이미지 (2026-09-16 사장님 지시):
//    이미지만 오면 답하지 않고 «이미지 확인되었습니다» 만 보낸다. 모아 뒀다가
//    그 다음 «글» 이 오면 이미지와 함께 읽고 그 글에 답한다. 답했으면 이미지는 처리된 것으로 비운다.
//    캡션이 붙어 와도 캡션은 이미지 설명으로만 보관한다(앨범 여러 장을 한 글로 묶기 위해).
const INBOX = path.join(DATA, 'tg_inbox');
let pending = [];        // ponytail: 메모리에만 둔다 — 창이 재시작되면 받아둔 이미지는 버려진다(밀린 글 버리는 정책과 같음)
let lastAlbum = '';

// 메시지에서 이미지 file_id 를 뽑는다 (사진 = 가장 큰 해상도, 파일로 보낸 이미지도 받는다)
function pickImage(m) {
  if (Array.isArray(m.photo) && m.photo.length) return { id: m.photo[m.photo.length - 1].file_id, ext: '.jpg' };
  const d = m.document;
  if (d && /^image\//.test(d.mime_type || '')) return { id: d.file_id, ext: path.extname(d.file_name || '') || '.jpg' };
  return null;
}

// 📄 파일 받기 (2026-10-14 사장님 지시: «파일도 읽을 수 있게»):
//    이미지가 아닌 파일(PDF·엑셀·한글·CSV·글 등)을 받는다. 이미지는 위 pickImage 가 먼저 가져간다.
//    텔레그램 봇은 20MB 까지만 내려받을 수 있다 — 넘으면 download 가 실패하고 아래에서 알린다.
function pickFile(m) {
  const d = m.document;
  if (!d) return null;
  if (/^image\//.test(d.mime_type || '')) return null;   // 이미지는 pickImage 몫
  const name = String(d.file_name || '');
  return { id: d.file_id, ext: path.extname(name) || '', name: name || '(이름없는 파일)', size: d.file_size || 0 };
}

async function download({ id, ext }) {
  const f = await api('getFile', { file_id: id });
  if (!f.ok) throw new Error('getFile 실패: ' + (f.description || ''));
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('다운로드 실패 HTTP ' + res.status);
  fs.mkdirSync(INBOX, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(INBOX, `${stamp}_${id.slice(-8).replace(/[^\w-]/g, '')}${ext}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// 🧵 PC 터미널 대화 이어받기 (2026-09-16 사장님 지시):
//    사장님이 PC 터미널(헤드쿼터스)에서 하던 대화를 폰에서 이어서 말해도 맥락이 끊기지 않게,
//    «지난번 폰 글 이후에» 터미널에서 오간 사용자/어시스턴트 글의 꼬리를 프롬프트 앞에 붙인다.
//    터미널 세션 파일을 같이 쓰지(--resume) 않는다 — 열려 있는 세션에 두 프로세스가 쓰면 깨진다. 읽기만 한다.
const PROJ = path.join(process.env.USERPROFILE || '', '.claude', 'projects',
  HQ.replace(/[^a-zA-Z0-9]/g, '-'));   // Claude Code 가 cwd 를 이렇게 뭉갠다. 도메인 폴더들이 전부 같은 이름이 된다 → cwd 로 거른다
const SEEN = path.join(DATA, '.tg_bridge_seen');
const readSeen = () => { try { return Number(fs.readFileSync(SEEN, 'utf8')) || 0; } catch { return 0; } };
const saveSeen = (t) => { try { fs.writeFileSync(SEEN, String(t)); } catch { /* noop */ } };

const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((x) => x.type === 'text' && x.text).map((x) => x.text).join('\n') : '';

// transcript 줄들 → since 이후의 [role, text] 목록 (도구 호출/결과·명령 잡음은 뺀다)
function pickTurns(lines, since, cwd = HQ) {
  const out = [];
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if ((j.type !== 'user' && j.type !== 'assistant') || !j.timestamp || j.cwd !== cwd) continue;
    if (Date.parse(j.timestamp) <= since) continue;
    const t = textOf(j.message?.content).trim();
    if (!t || /^<(local-command|command-name)/.test(t)) continue;
    out.push([j.type === 'user' ? '사장님' : '클로드', t.slice(0, 1500), Date.parse(j.timestamp)]);
  }
  return out;
}

function terminalTail(since, excludeSid) {
  let turns = [];
  try {
    for (const f of fs.readdirSync(PROJ)) {
      if (!f.endsWith('.jsonl') || f.startsWith(excludeSid || '\0')) continue;
      const full = path.join(PROJ, f);
      if (fs.statSync(full).mtimeMs <= since) continue;
      turns.push(...pickTurns(fs.readFileSync(full, 'utf8').split(/\r?\n/), since));
    }
  } catch (e) { console.error('[터미널 대화 읽기 실패]', e.message); }
  turns = turns.sort((a, b) => a[2] - b[2]).slice(-8);   // 파일 여러 개에서 모였으니 시간순으로   // ponytail: 꼬리 8턴이면 «무슨 얘기 중이었는지» 는 충분하다. 더 필요하면 늘린다
  if (!turns.length) return '';
  return `[참고: 사장님이 PC 터미널(헤드쿼터스)에서 최근 나눈 대화입니다. 폰에서 이어서 말씀하시면 이 맥락에 이어서 답하세요.]\n`
    + turns.map(([r, t]) => `${r}: ${t}`).join('\n---\n') + '\n\n[사장님 글 (폰)]\n';
}

function withImages(text, imgs) {
  if (!imgs.length) return text;
  const list = imgs.map((x, i) => `${i + 1}) ${x.file}${x.caption ? `  (캡션: ${x.caption})` : ''}`).join('\n');
  return `[사장님이 텔레그램으로 이미지 ${imgs.length}장을 먼저 보내셨습니다. Read 도구로 이미지를 열어 보고, 아래 글과 함께 읽은 뒤 «글» 에 대해 답하세요.]\n${list}\n\n[사장님 글]\n${text}`;
}

// 📄 이미지 + 파일을 함께 프롬프트에 붙인다 (2026-10-14 추가)
//    pending 항목에 kind:'file' 이 붙은 것은 파일, 없으면 이미지(기존 그대로).
function withAttach(text, items) {
  if (!items || !items.length) return text;
  const imgs = items.filter((x) => x.kind !== 'file');
  const docs = items.filter((x) => x.kind === 'file');
  let out = withImages(text, imgs);          // 이미지는 기존 방식 그대로
  if (!docs.length) return out;
  const list = docs.map((x, i) =>
    `${i + 1}) ${x.file}${x.name ? `  (보낸 이름: ${x.name})` : ''}${x.caption ? `  (캡션: ${x.caption})` : ''}`).join('\n');
  const head = `[사장님이 텔레그램으로 파일 ${docs.length}개를 먼저 보내셨습니다. 아래 경로의 파일을 열어 보고, 아래 글과 함께 읽은 뒤 «글» 에 대해 답하세요.`
    + ` 글·PDF 는 Read 도구로, 엑셀·한글 같은 것은 알맞은 방법으로 읽으세요(엑셀은 openpyxl, 한글은 hwp2txt 등).]\n${list}\n\n`;
  // 이미지 안내가 이미 붙었다면 그 뒤에, 없으면 맨 앞에 파일 안내를 넣는다
  return imgs.length ? head + out : head + `[사장님 글]\n${text}`;
}

const readOffset = () => { try { return Number(fs.readFileSync(STATE, 'utf8')) || 0; } catch { return 0; } };
const saveOffset = (n) => { try { fs.writeFileSync(STATE, String(n)); } catch { /* noop */ } };

// 🛑 사장님 지시(2026-09-08): «가동 이후» 온 글만 본다.
//    텔레그램은 브릿지가 꺼져 있는 동안 온 글을 최대 24시간 쌓아 뒀다가 켜는 순간 한꺼번에 준다.
//    그걸 그대로 받으면 이미 끝낸 일을 혼자 다시 한다(사장님이 여러 번 겪으심).
//    → 켤 때 밀린 것은 «실행하지 않고» 지나간 것으로 처리하고, 그 뒤에 오는 글부터 받는다.
//    창이 죽었다 되살아나는 경우(cmd 재시작 루프)도 같다 — 꺼져 있던 사이의 글은 버린다.
// saved = 저장돼 있던 offset, result = getUpdates({offset:-1}) 의 result
// 반환 = 앞으로 쓸 offset (이 번호보다 큰 글부터 처리된다)
function skipTo(saved, result) {
  const last = Array.isArray(result) && result.length ? result[result.length - 1] : null;
  const id = last && Number(last.update_id);
  return Number.isFinite(id) && id > saved ? id : saved;
}

// 자체점검:  node tg_bridge.cjs --selftest
if (process.argv.includes('--selftest')) {
  const a = require('node:assert');
  a.strictEqual(skipTo(100, [{ update_id: 105 }]), 105, '밀린 글이 있으면 마지막까지 건너뛴다');
  a.strictEqual(skipTo(100, []), 100, '밀린 글이 없으면 그대로 둔다');
  a.strictEqual(skipTo(100, null), 100, '응답이 깨져도 offset 을 되돌리지 않는다');
  a.strictEqual(skipTo(100, [{ update_id: 90 }]), 100, '옛 update_id 로 뒤로 가지 않는다');
  a.strictEqual(pickImage({ photo: [{ file_id: 's' }, { file_id: 'L' }] }).id, 'L', '사진은 가장 큰 것');
  a.strictEqual(pickImage({ document: { file_id: 'd', mime_type: 'image/png', file_name: 'a.png' } }).ext, '.png', '파일로 보낸 이미지');
  a.strictEqual(pickImage({ document: { file_id: 'd', mime_type: 'application/pdf' } }), null, 'PDF 는 이미지 아님');
  a.strictEqual(withImages('안녕', []), '안녕', '이미지 없으면 글 그대로');
  a.ok(withImages('이거 뭐야', [{ file: 'C:\\a.jpg', caption: '' }]).includes('C:\\a.jpg'), '이미지 경로가 프롬프트에 들어간다');
  // 📄 파일 받기 (2026-10-14 추가)
  a.strictEqual(pickFile({ document: { file_id: 'd', mime_type: 'application/pdf', file_name: 'a.pdf' } }).ext, '.pdf', 'PDF 는 파일로 받는다');
  a.strictEqual(pickFile({ document: { file_id: 'd', mime_type: 'image/png', file_name: 'a.png' } }), null, '이미지는 파일로 안 받는다(pickImage 몫)');
  a.strictEqual(pickFile({ photo: [{ file_id: 's' }] }), null, '사진은 파일 아님');
  a.strictEqual(pickFile({ text: '안녕' }), null, '글은 파일 아님');
  a.strictEqual(pickFile({ document: { file_id: 'd', mime_type: 'application/octet-stream' } }).name, '(이름없는 파일)', '이름 없으면 기본 이름');
  a.strictEqual(withAttach('안녕', []), '안녕', '붙인 것 없으면 글 그대로');
  const onlyDoc = withAttach('이거 봐', [{ file: 'C:\\b.pdf', name: 'b.pdf', caption: '', kind: 'file' }]);
  a.ok(onlyDoc.includes('C:\\b.pdf') && onlyDoc.includes('파일 1개'), '파일만 보낸 경우 경로가 프롬프트에 들어간다');
  a.ok(onlyDoc.includes('[사장님 글]\n이거 봐'), '파일만 보낸 경우에도 글이 붙는다');
  const both = withAttach('둘 다', [{ file: 'C:\\a.jpg', caption: '' }, { file: 'C:\\b.pdf', name: 'b.pdf', caption: '', kind: 'file' }]);
  a.ok(both.includes('C:\\a.jpg') && both.includes('C:\\b.pdf'), '이미지와 파일을 같이 보내도 둘 다 들어간다');
  a.ok(both.includes('이미지 1장') && both.includes('파일 1개'), '이미지·파일 개수를 각각 알린다');
  const pr = parseResult('{"type":"result","is_error":false,"result":"답","session_id":"abc"}', 0);
  a.deepStrictEqual([pr.ok, pr.text, pr.sid], [true, '답', 'abc'], 'JSON 결과 파싱');
  a.strictEqual(parseResult('깨진 출력', 1).ok, false, 'JSON 아니면 실패');
  const mk = (type, content, ts, cwd = HQ) => JSON.stringify({ type, cwd, timestamp: ts, message: { content } });
  const T = pickTurns([
    mk('user', '옛글', '2026-09-16T00:00:00Z'),
    mk('user', '새글', '2026-09-16T02:00:00Z'),
    mk('assistant', [{ type: 'tool_use' }, { type: 'text', text: '답' }], '2026-09-16T02:01:00Z'),
    mk('user', [{ type: 'tool_result', content: 'x' }], '2026-09-16T02:02:00Z'),
    mk('user', '<command-name>/model</command-name>', '2026-09-16T02:03:00Z'),
    mk('user', '다른폴더', '2026-09-16T02:04:00Z', 'C:\\다른곳'),
  ], Date.parse('2026-09-16T01:00:00Z'));
  a.deepStrictEqual(T.map((x) => x.slice(0, 2)), [['사장님', '새글'], ['클로드', '답']], '터미널 꼬리: since 이후·본문만·다른 cwd 제외');
  console.log('브릿지 자체점검 22건 통과');
  process.exit(0);
}

// 📥 줄 세우기 (2026-10-08 사장님 지시: «문자 보내면 바로 확인했다 하고 해야지»):
//    예전엔 한 작업이 끝날 때까지 다음 글을 아예 받지 않아서, 작업 중에 보낸 글에는 몇 시간이고 답이 없었다.
//    → 글은 받는 즉시 «확인했습니다» 로 답하고, 작업은 줄에 세워 온 순서대로 하나씩 돌린다.
let chain = Promise.resolve();
let waiting = 0;   // 돌고 있는 것 + 줄 선 것

async function handle(msg) {
  const img = pickImage(msg);
  if (img) {
    try {
      pending.push({ file: await download(img), caption: String(msg.caption || '').trim() });
    } catch (e) {
      await say('🛑 이미지를 받지 못했습니다: ' + String(e.message).slice(0, 200));
      return;
    }
    // 앨범(여러 장 한 번에)은 한 번만 알린다
    if (!msg.media_group_id || msg.media_group_id !== lastAlbum) await say('🖼 이미지 확인되었습니다.');
    lastAlbum = msg.media_group_id || '';
    return;
  }

  // 📄 파일 (2026-10-14 사장님 지시) — 이미지와 똑같이: 받아 두고 «확인했습니다» 만 답한 뒤,
  //    다음에 보내시는 글과 함께 읽는다.
  const doc = pickFile(msg);
  if (doc) {
    if (doc.size > 20 * 1024 * 1024) {
      await say(`🛑 «${doc.name}» 은 ${(doc.size / 1048576).toFixed(1)}MB 라 받을 수 없습니다.`
        + ' 텔레그램 봇은 20MB 까지만 됩니다. 쪼개서 보내시거나 PC 에 두고 경로를 알려 주세요.');
      return;
    }
    try {
      pending.push({ file: await download(doc), caption: String(msg.caption || '').trim(), kind: 'file', name: doc.name });
    } catch (e) {
      await say('🛑 파일을 받지 못했습니다: ' + String(e.message).slice(0, 200));
      return;
    }
    await say(`📄 파일 확인되었습니다. (${doc.name})`);
    return;
  }

  const text = String(msg.text || '').trim();
  if (!text) {
    // 음성·파일·스티커 등 — 말없이 넘기면 «안 받은 것» 처럼 보인다
    if (msg.voice || msg.audio || msg.video || msg.video_note || msg.sticker || msg.location || msg.contact) {
      await say('⚠ 이 형식은 아직 읽지 못합니다. 글·사진·파일로 보내 주세요.');
    }
    return;
  }

  // 🛑 한글 뒤에는 \b 가 먹지 않는다(«/취소»·«/새로» 가 명령으로 안 잡혔다) → (?=s|$) 로 끝을 본다
  // /start 는 텔레그램이 «시작» 버튼으로 보내는 것 — Claude 에 넘기지 않고 안내로 받는다
  if (/^\/(start|시작)(?=\s|$)/i.test(text)) {
    await say('📱 연결됐습니다. 이제 여기로 그냥 쓰시면 PC 에서 실행하고 결과를 돌려드립니다.\n\n· 그냥 쓰기 → 이전 대화에 이어서\n· 「/새로 …」 → 새 대화로\n· 「/상태」 → 살아 있는지 확인\n· 「/할일」 로 할 일 판 보기 · 「/할일 추가」 로 올리기\n· 「/취소」 → 하던 일 중지하고 다음 명령 대기\n· 🖼 이미지 → «확인되었습니다» 만 답하고, 다음에 보내시는 글과 함께 읽습니다\n· 📄 파일(PDF·엑셀·한글·CSV 등) → 똑같이 «확인되었습니다» 만 답하고, 다음 글과 함께 읽습니다 (20MB 까지)');
    return;
  }
  // /취소 (2026-10-08 사장님): 하던 일을 딱 끊고 다음 명령을 기다린다. 봇은 계속 살아서 감지한다.
  if (/^\/(취소|중지|정지|stop|cancel)(?=\s|$)/i.test(text)) {
    const busy = !!current, queued = Math.max(0, waiting);
    gen++;                      // 줄 서 있던 작업을 모두 무효로 만든다
    addWaitAt = 0;            // 할 일 추가 대기도 푼다
    const killed = killCurrent();
    waiting = 0;
    pending = [];               // 모아 둔 이미지도 버린다
    chain = Promise.resolve();  // 대기열 비우기
    console.log(`[취소] 돌던일 ${killed ? 1 : 0}건 - 대기 ${queued}건`);
    await say(busy || queued
      ? `🛑 중지했습니다.${killed ? " 하던 일을 끊었습니다." : ""}${queued > 1 ? ` 줄 서 있던 ${queued - 1}건도 취소했습니다.` : ""}\n\n다음 명령을 기다립니다.`
      : "✅ 지금 하고 있는 일이 없습니다. 다음 명령을 기다립니다.");
    return;
  }

  // 할일 판 보기·추가 — 칠판(todo.json) 과 링크드를 바로 잇는다
  if (/^\/(할일|할 일|todo)(?=\s|$)/i.test(text)) {
    const rest = text.replace(/^\/(할일|할 일|todo)\s*/i, "").trim();
    try {
      if (/^(추가|add)\b/i.test(rest)) {
        const title = rest.replace(/^(추가|add)\s*/i, "").trim();
        if (!title) {
          addWaitAt = Date.now();
          await say("무엇을 추가해 드릴까요?\n다음 글을 그대로 할 일로 올립니다.\n(3분 안에 보내 주세요 · 그만두려면 /취소)");
          return;
        }
        const { T } = todoLines();
        const it = T.add({ title, who: "사장님", by: "링크드" });
        await say(`✅ ${it.id}번으로 올렸습니다\n${it.title}`);
        return;
      }
      const { d, items } = todoLines();
      const ST = { todo: "할 일", propose: "승인 대기", doing: "진행 중", confirm: "완료 확인", wait: "대기 중", check: "확인 필요", later: "나중에" };
      const mine = items.filter((x) => x.who === "사장님"), ours = items.filter((x) => x.who !== "사장님");
      const row = (x) => `${x.id}. [${ST[x.status] || x.status}] ${x.title}${x.note ? " — " + x.note : ""}`;
      let out = `📋 할 일 ${items.length}건 (고친 때 ${d.updated})`;
      if (mine.length) out += "\n\n■ 사장님\n" + mine.map(row).join("\n");
      if (ours.length) out += "\n\n■ Claude\n" + ours.map(row).join("\n");
      out += "\n\n/할일 추가 — 새 할 일 올리기";
      await say(out.slice(0, 3800));
    } catch (e) {
      await say("🛑 할 일 판을 읽지 못했습니다: " + String(e.message).slice(0, 120));
    }
    return;
  }

  if (/^\/(상태|status|ping)$/i.test(text)) {
    await say(`✅ 브릿지 살아 있습니다. ${waiting ? `지금 작업 ${waiting}건을 처리하고 있습니다.` : '헤드쿼터스에서 대기 중입니다.'}`);
    return;
  }

  // 「/할일 추가」 를 누른 뒤 3분 안에 온 첫 글 → 그대로 할 일로 올린다 (Claude 로 안 넘김)
  if (addWaitAt && Date.now() - addWaitAt < ADD_WINDOW_MS && !/^\//.test(text)) {
    addWaitAt = 0;
    try {
      const { T } = todoLines();
      const it = T.add({ title: text.slice(0, 200), who: "사장님", by: "링크드" });
      await say(`✅ ${it.id}번으로 올렸습니다\n${it.title}\n\n/할일 로 목록을 봅니다`);
    } catch (e) {
      await say("🛑 올리지 못했습니다: " + String(e.message).slice(0, 120) + "\n다시 /할일 추가 로 해 주세요.");
    }
    return;
  }

  const fresh = /^\/(새로|새대화|new)(?=\s|$)/i.test(text);
  const prompt = fresh ? text.replace(/^\/(새로|새대화|new)(?=\s|$)\s*/i, '') : text;
  if (!prompt) { await say('무엇을 할지 함께 적어 주세요. 예) /새로 오늘 할 일 정리해줘'); return; }

  const ahead = waiting++;
  const imgs = pending;
  pending = [];   // 이 글이 가져간다 — 실패하면 아래에서 되돌려 다음 글과 함께 읽는다
  await say(`✅ 확인했습니다${fresh ? ' (새 대화)' : ''}${imgs.length ? ` · 이미지 ${imgs.length}장 함께 읽습니다` : ''}. `
    + (ahead ? `앞의 작업 ${ahead}건이 끝나면 이어서 하겠습니다.` : '바로 시작합니다…'));
  const myGen = gen;   // /취소 가 눌리면 이 번호가 바뀌어 아래 작업을 건너뛴다
  chain = chain.then(() => (myGen === gen ? work(prompt, fresh, imgs, myGen) : undefined))
    .finally(() => { if (myGen === gen && waiting > 0) waiting--; });   // 취소된 옛 작업이 새 작업의 숫자를 깎지 않게
}

async function work(prompt, fresh, imgs, myGen = gen) {
  const t0 = Date.now();
  try {
    const opts = {
      fresh,
      onSlow: () => { say(`🕗 아직 돌고 있습니다 (${Math.round((Date.now() - t0) / 60000)}분째). 걸어둘 테니 끝나면 알려드리겠습니다.`); },
    };
    const seen = readSeen();
    // «/새로» 는 말 그대로 새 얘기다 — 터미널 꼬리도, 직전 폰 대화도 붙이지 않는다.
    //   (대화번호가 바뀌면 직전 폰 대화 파일이 «터미널 대화» 로 잘못 딸려 들어왔다 → 여기서 선을 긋는다)
    if (fresh) saveSeen(t0);
    const tail = fresh ? '' : terminalTail(seen, readSession());
    // 끊은 뒤 첫 글: 앞 명령에 이어지는 말이면 잇고, 다른 얘기면 앞 작업은 참고하지 않는다
    const note = interrupted && !fresh
      ? '[알림: 사장님이 바로 앞의 작업을 «/취소» 로 중간에 끊으셨습니다. 끊긴 작업을 스스로 다시 시작하지 마세요. 아래 글이 앞의 명령에 이어지는 말이면 그 명령을 기준으로 이어서 하고, 전혀 다른 얘기면 앞의 작업은 참고하지 말고 아래 글만 하세요.]\n\n'
      : '';
    interrupted = false;
    const full = note + tail + withAttach(prompt, imgs);
    let r = await runClaude(full, opts);
    // 저장된 대화가 지워졌으면(No conversation found) 그때만 새 대화로 한 번 더 — 일부 실행된 작업을 중복하지 않게 이 경우만
    if (!r.ok && r.resumed && /no conversation found/i.test(`${r.err} ${r.out}`)) {
      saveSession('');
      await say('⚠ 이전 대화를 찾지 못해 새 대화로 시작합니다.');
      r = await runClaude(full, { ...opts, fresh: true });
    }
    // /취소 로 끊긴 경우 — 실패 메시지를 보내지 않고 조용히 끝낸다
    if (myGen !== gen) { console.log("[취소] 결과 버림"); return; }
    if (r.ok) saveSeen(t0);   // 여기까지의 터미널 대화는 폰 대화에 들어갔다 — 다음엔 이 뒤에 생긴 것만 붙인다
    const took = Math.round((Date.now() - t0) / 1000);
    const spent = took >= 60 ? `${Math.floor(took / 60)}분 ${took % 60}초` : `${took}초`;
    if (!r.ok) pending = imgs.concat(pending);   // 답하지 못했으면 이미지를 되돌려 둔다
    console.log(`[끝] ${r.ok ? '성공' : '실패'} ${spent}`);
    if (r.ok && r.out) await say(`${r.out}\n\n— ${spent}`);
    else await say(`🛑 실패 (${spent})\n${(r.err || r.out || '출력이 없습니다').slice(0, 1500)}`);
  } catch (e) {
    pending = imgs.concat(pending);
    console.error('[브릿지 오류]', e.message);
    await say('🛑 브릿지 오류: ' + String(e.message).slice(0, 300));
  }
}

// 🛑 두 개가 동시에 폴링하면 텔레그램이 409 로 막는다(둘 다 먹통). 한 번에 하나만 돈다.
const LOCK = path.join(DATA, '.tg_bridge_lock');
function claimLock() {
  try {
    const old = Number(fs.readFileSync(LOCK, 'utf8'));
    if (old && old !== process.pid) {
      // 재부팅 뒤에는 옛 번호를 다른 프로그램이 쓰고 있을 수 있다 → 그 번호가 «node» 일 때만 돌고 있는 것으로 본다
      try {
        process.kill(old, 0);
        const who = require('node:child_process').execSync(
          `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${old}').CommandLine"`, { encoding: 'utf8', windowsHide: true });
        if (/tg_bridge/i.test(who)) return false;
      } catch { /* 죽은 PID — 이어받는다 */ }
    }
  } catch { /* 락 없음 */ }
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch { /* noop */ } if (sig !== 'exit') process.exit(0); });
}

module.exports = { handle, runClaude, api, OWNER };   // 실사용 테스트용 (require 하면 폴링은 안 돈다)

if (require.main === module) (async () => {
  if (!claimLock()) { console.log('🛑 브릿지가 이미 돌고 있습니다 — 이 창은 그냥 닫으셔도 됩니다.'); process.exit(0); }
  console.log(`[브릿지] 시작 — 헤드쿼터스 ${HQ}`);
  console.log(`[브릿지] 허용 chat_id ${OWNER}`);
  // 🛑 봇에게 «시작(/start)» 을 누르기 전에는 먼저 말을 걸 수 없다(chat not found). 그래도 죽지 않는다.
  const hello = await api('sendMessage', {
    chat_id: OWNER,
    text: '📱 헤드쿼터스 브릿지를 켰습니다. 여기로 보내시면 PC 에서 실행하고 결과를 돌려드립니다.\n· 그냥 쓰시면 이전 대화에 이어서\n· 「/새로 …」 는 새 대화로\n· 「/상태」 로 살아 있는지 확인\n· 「/할일」 로 할 일 판 보기 · 「/할일 추가」 로 올리기\n· 「/취소」 로 하던 일을 중지하고 다음 명령 대기\n\n※ 꺼져 있는 동안 보내신 글은 처리하지 않습니다. 지금부터 보내시는 것만 받습니다.',
  });
  if (!hello.ok) {
    console.log('※ 아직 인사를 못 보냅니다 —', String(hello.description || '').slice(0, 60));
    console.log('   텔레그램에서 봇을 열고 «시작(/start)» 을 한 번 눌러 주세요. 그 뒤부터 정상 동작합니다.');
  }
  let offset = readOffset();
  try {
    const pend = await api('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] });
    const next = pend.ok ? skipTo(offset, pend.result) : offset;
    if (next !== offset) {
      const n = next - offset;   // update_id 는 봇마다 이어지는 번호라 «대략 몇 건» 인지 알려 준다
      offset = next;
      saveOffset(offset);
      console.log(`[브릿지] 꺼져 있는 동안 밀린 글 약 ${n}건은 «처리하지 않고» 건너뜁니다 (update_id ${offset} 까지).`);
      await say(`⏭ 꺼져 있는 동안 보내신 글 약 ${n}건은 처리하지 않고 넘겼습니다. 지금부터 보내시는 것만 받습니다.`);
    } else {
      console.log('[브릿지] 밀린 글 없음 — 바로 대기합니다.');
    }
  } catch (e) {
    // 여기서 실패하면 옛 글이 다시 실행될 수 있다 — 조용히 넘기지 않고 알린다
    console.error('[브릿지] 밀린 글 정리 실패 — ' + String(e.message).slice(0, 80));
    await say('⚠ 켜면서 밀린 글을 정리하지 못했습니다. 옛 글이 다시 실행될 수 있으니 창을 닫았다 다시 켜 주세요.');
  }
  let lastFail = '';
  for (;;) {
    try {
      const r = await api('getUpdates', { offset: offset + 1, timeout: 30, allowed_updates: ['message'] });
      if (!r.ok) {
        // 말없이 귀가 먹지 않게 — 이유가 바뀔 때마다 한 번씩 남긴다 (409 = 같은 봇이 다른 곳에서도 켜져 있다)
        const why = String(r.description || r.error || '').slice(0, 120);
        if (why !== lastFail) { lastFail = why; console.error('[받기 실패]', why); }
        await new Promise((s) => setTimeout(s, 5000)); continue;
      }
      if (lastFail) { console.log('[받기 회복]'); lastFail = ''; }
      for (const u of r.result || []) {
        offset = Math.max(offset, u.update_id);
        saveOffset(offset);
        const m = u.message;
        if (!m) continue;
        if (String(m.chat?.id) !== OWNER) {
          console.log(`[무시] 허용 안 된 chat_id ${m.chat?.id} (${m.from?.first_name || ''}) — 사장님 것이 맞다면 .env TELEGRAM_CHAT_ID 를 이 값으로 바꾸세요`);
          continue;
        }
        console.log('[받음]', pickImage(m) ? '(이미지)' : String(m.text || '').slice(0, 60));
        await handle(m);
      }
    } catch (e) {
      console.error('[폴링 오류]', e.message);
      await new Promise((s) => setTimeout(s, 5000));
    }
  }
})();
