// 🔐 로그인·인증 요청 봇 («비밀번호 링크드봇»)
//   로그인이 풀렸거나 인증이 필요할 때 사장님께 텔레그램으로 요청하고, 사장님이 폰에서 보낸 값을
//   작업 크롬의 로그인 칸에 «대신 쳐 넣는다». 받은 글은 받자마자 텔레그램에서 지운다.
//
//   사용: node auth/tg_ask.cjs "<무엇이 필요한지>" [탭 주소 일부] [기다릴 분=30]
//   예)   node auth/tg_ask.cjs "원셀 로그인이 풀렸습니다" onesell
//         node auth/tg_ask.cjs "ESMPlus 로그인이 풀렸습니다" esmplus
//   폰에서:  /아이디 값   /비번 값   /인증 값   /로그인   · 끝나면 «완료» · 그만두려면 «취소»
//   종료코드: 0 완료 · 2 취소 · 3 시간 초과 · 1 설정/전송 오류
//
// 🛑 값은 이 프로세스 메모리에서 크롬 입력칸으로만 간다. 파일·로그·화면 출력·Claude 프롬프트 어디에도 남기지 않는다.
// 🛑 사장님 chat_id 에서 온 글만 본다. 그 외는 무시한다.
// 🛑 링크드 봇(@Headlinkbot)과 «다른 봇» 을 쓴다. 같은 봇이면 브릿지가 글을 먼저 가져가고, 비밀번호가 Claude 대화에 들어간다.
// ※ 텔레그램 봇 대화는 종단간 암호화가 아니다. 지워도 «전송 중 텔레그램 서버를 거쳤다» 는 사실은 남는다.
const fs = require('node:fs');

require('../lib/env.cjs');   // 리포 맨 위 .env
const TOKEN = process.env.AUTH_TG_BOT_TOKEN;
const OWNER = String(process.env.TELEGRAM_CHAT_ID || '');

// \b 는 한글 뒤에서 안 먹는다 → 뒤가 공백·끝·문장부호인지로 본다
const DONE = /^\s*(완료|했어|했음|됐어|끝|ㅇㅋ|ok|done|yes|y)(?=\s|$|[.!~])/i;
const CANCEL = /^\s*(취소|중단|그만|안해|stop|cancel|no)(?=\s|$|[.!~])/i;
const TOK = /(^|\s)\/(아이디|id|비번|비밀번호|pw|인증|otp|code|보안문자|보안|captcha|화면|screen|로그인|login)(?:@\w+)?(?=\s|$)/gi;
const KIND = { 아이디: 'id', id: 'id', 비번: 'pw', 비밀번호: 'pw', pw: 'pw', 인증: 'otp', otp: 'otp', code: 'otp', 보안: 'captcha', 보안문자: 'captcha', captcha: 'captcha', 화면: 'screen', screen: 'screen', 로그인: 'submit', login: 'submit' };

// 글 하나 → [{ kind, value }…]. 한 글에 «/아이디 a /비번 b» 처럼 여러 개를 같이 보내도 각각 나눈다
// (10-07: 같이 보내신 글이 통째로 아이디 칸에 들어갔다). 값 = 그 명령 뒤부터 다음 명령 앞까지.
function parseAll(text) {
  const hits = [...String(text).matchAll(TOK)];
  if (!hits.length) { const k = DONE.test(text) ? 'done' : CANCEL.test(text) ? 'cancel' : null; return k ? [{ kind: k, value: '' }] : []; }
  return hits.map((h, i) => ({
    kind: KIND[h[2].toLowerCase()],
    value: text.slice(h.index + h[0].length, i + 1 < hits.length ? hits[i + 1].index : text.length).trim(),
  }));
}

// 자체점검:  node auth/tg_ask.cjs --selftest
if (process.argv.includes('--selftest')) {
  const a = require('node:assert');
  a.deepStrictEqual(parseAll('/아이디 abc'), [{ kind: 'id', value: 'abc' }]);
  a.deepStrictEqual(parseAll('/비번 p@ss w0rd!'), [{ kind: 'pw', value: 'p@ss w0rd!' }], '비번 안의 공백·기호 그대로');
  a.deepStrictEqual(parseAll('/pw@SomeBot x1'), [{ kind: 'pw', value: 'x1' }], '봇 이름이 붙어 와도');
  a.deepStrictEqual(parseAll('/아이디 abc /비번 x/y1!'), [{ kind: 'id', value: 'abc' }, { kind: 'pw', value: 'x/y1!' }], '한 글에 같이 · 비번 안의 / 는 그대로');
  a.deepStrictEqual(parseAll('/아이디 abc\n/비번 def\n/로그인'), [{ kind: 'id', value: 'abc' }, { kind: 'pw', value: 'def' }, { kind: 'submit', value: '' }], '줄바꿈으로 같이');
  a.deepStrictEqual(parseAll('/인증 123456'), [{ kind: 'otp', value: '123456' }]);
  a.deepStrictEqual(parseAll('/보안 a7Kq2'), [{ kind: 'captcha', value: 'a7Kq2' }]);
  a.deepStrictEqual(parseAll('/보안'), [{ kind: 'captcha', value: '' }], '값 없이 보내면 화면 사진 요청');
  a.strictEqual(parseAll('/화면')[0].kind, 'screen');
  a.strictEqual(parseAll('완료')[0].kind, 'done'); a.strictEqual(parseAll(' 했어 ')[0].kind, 'done'); a.strictEqual(parseAll('OK')[0].kind, 'done');
  a.strictEqual(parseAll('취소')[0].kind, 'cancel'); a.strictEqual(parseAll('잠깐만').length, 0); a.strictEqual(parseAll('').length, 0);
  console.log('tg_ask 자체점검 15건 통과'); process.exit(0);
}

if (!TOKEN || !OWNER) { console.error('🛑 .env 에 AUTH_TG_BOT_TOKEN / TELEGRAM_CHAT_ID 가 필요합니다'); process.exit(1); }
const api = (m, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()).catch((e) => ({ ok: false, description: String(e) }));
const say = (text) => api('sendMessage', { chat_id: OWNER, text, disable_web_page_preview: true });

// ── 작업 크롬 로그인 칸 찾기·입력 ──────────────────────────────────────────
const VISIBLE = (sel) => `${sel}:visible`;
const ID_SEL = 'input[type="text"], input[type="email"], input[type="tel"], input:not([type])';
const OTP_SEL = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[id*="otp" i], input[id*="code" i], input[name*="auth" i], input[inputmode="numeric"]';

// 비밀번호 칸이 보이는 탭 = 로그인 화면. hint(주소 일부)가 있으면 그 탭만 본다.
async function loginPage(ctx, hint, sel = 'input[type="password"]') {
  for (const p of ctx.pages()) {
    if (hint && !p.url().includes(hint)) continue;
    for (const f of p.frames()) {
      try { if (await f.locator(VISIBLE(sel)).count()) return { page: p, frame: f }; } catch { /* 닫힌 프레임 */ }
    }
  }
  return null;
}

// 사람이 치듯 한 글자씩 넣는다 (붙여넣기를 막는 로그인 창이 있다)
async function typeInto(page, loc, value) {
  await loc.click();
  await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
  await page.keyboard.type(value, { delay: 70 + Math.floor(Math.random() * 50) });
}

// 보안문자(글자를 읽어 적는 종류)는 사장님이 사진을 보고 답을 보낸다. 여기서는 풀지 않고 받은 답만 쳐 넣는다.
const CAPTCHA_SEL = 'input[id*="captcha" i], input[name*="captcha" i], input[placeholder*="보안"], input[placeholder*="자동입력"], input[placeholder*="정답"], input[title*="보안"], input[title*="자동입력"], input[aria-label*="보안"]';

// 지금 로그인 중인 탭의 화면을 사장님께 사진으로 보낸다 (보안문자 그림 확인·로그인 결과 확인용)
async function sendScreen(ctx, hint, caption) {
  const t = last || await loginPage(ctx, hint);
  const page = t ? t.page : (ctx.pages().find((p) => hint && p.url().includes(hint)) || ctx.pages()[0]);
  if (!page) return '열려 있는 탭이 없습니다.';
  await page.bringToFront();
  const form = new FormData();
  form.append('chat_id', OWNER); form.append('caption', caption);
  form.append('photo', new Blob([await page.screenshot()]), 'screen.png');
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: form }).then((x) => x.json()).catch((e) => ({ ok: false, description: String(e) }));
  return r.ok ? '' : '화면 사진을 보내지 못했습니다: ' + String(r.description || '').slice(0, 100);
}

let last = null;   // 마지막으로 값을 넣은 탭 — 로그인 누르기·결과 확인은 이 탭에서 한다 (같은 사이트 탭이 여러 개여도 안 헷갈리게)

// 아이디·비번 칸에 글자가 들어 있는지 «글자 수» 만 본다 (값은 읽지 않는다)
async function filled(t) {
  return t.frame.locator(VISIBLE('input[type="password"]')).first().evaluate((el, sel) => {
    const all = [...el.ownerDocument.querySelectorAll(sel + ', input[type="password"]')].filter((x) => x.offsetParent !== null);
    let id = 0; for (let i = all.indexOf(el) - 1; i >= 0; i--) if (all[i].type !== 'password') { id = all[i].value.length; break; }
    return { id, pw: el.value.length };
  }, ID_SEL).catch(() => null);
}

// 로그인 화면이 아직 남아 있나 (비밀번호 칸이 보이면 아직 안 들어간 것)
async function stillLogin(page) {
  for (const f of page.frames()) { try { if (await f.locator(VISIBLE('input[type="password"]')).count()) return true; } catch { /* 닫힌 프레임 */ } }
  return /login|signin/i.test(page.url());
}

async function fill(ctx, hint, kind, value) {
  if (kind === 'otp' || kind === 'captcha') {
    const sel = kind === 'otp' ? OTP_SEL : CAPTCHA_SEL;
    const t = await loginPage(ctx, hint, sel);
    if (!t) return kind === 'otp' ? '인증번호 칸을 찾지 못했습니다.' : '보안문자 칸을 찾지 못했습니다.';
    await t.page.bringToFront(); await typeInto(t.page, t.frame.locator(VISIBLE(sel)).first(), value);
    last = t;
    return '';
  }
  const t = (last && await stillLogin(last.page) && await last.frame.locator(VISIBLE('input[type="password"]')).count().catch(() => 0)) ? last : await loginPage(ctx, hint);
  if (!t) return '로그인 화면(비밀번호 칸)이 보이는 탭을 찾지 못했습니다.';
  await t.page.bringToFront();
  last = t;
  const pw = t.frame.locator(VISIBLE('input[type="password"]')).first();
  if (kind === 'pw') { await typeInto(t.page, pw, value); return ''; }
  if (kind === 'submit') { await pw.press('Enter'); return ''; }
  // 아이디 칸 = 비밀번호 칸 «바로 앞» 에 있는 보이는 글자 칸
  const idx = await pw.evaluate((el, sel) => {
    const all = [...el.ownerDocument.querySelectorAll(sel + ', input[type="password"]')].filter((x) => x.offsetParent !== null);
    const at = all.indexOf(el);
    for (let i = at - 1; i >= 0; i--) if (all[i].type !== 'password') { all[i].setAttribute('data-tgask-id', '1'); return i; }
    return -1;
  }, ID_SEL);
  if (idx < 0) return '아이디 칸을 찾지 못했습니다.';
  await typeInto(t.page, t.frame.locator('[data-tgask-id="1"]').first(), value);
  return '';
}

// 입력 점검:  node auth/tg_ask.cjs --formtest   (작업 크롬에 가짜 로그인 화면을 띄워 칸 찾기·입력·누르기·결과 확인을 본다. 텔레그램은 안 쓴다)
if (process.argv.includes('--formtest')) (async () => {
  const a = require('node:assert');
  const { browser, ctx } = await require('../lib/cdp.cjs').connect();
  const page = await ctx.newPage();
  await page.goto('data:text/html,' + encodeURIComponent('<title>tgask-formtest</title><form onsubmit="document.body.innerHTML=\'<p id=ok>in</p>\';return false"><input type=search style="display:none"><input placeholder="id"><input type=password><button>go</button></form>'));
  a.strictEqual(await fill(ctx, 'tgask-formtest', 'id', 'dummy-id'), '', '아이디 칸 못 찾음');
  a.strictEqual(last.page, page, '다른 탭에 입력됨');
  a.deepStrictEqual(await filled(last), { id: 8, pw: 0 }, '아이디만 들어가야 한다');
  a.strictEqual(await fill(ctx, '', 'pw', 'dummy-pw!'), '');
  a.deepStrictEqual(await filled(last), { id: 8, pw: 9 }, '칸이 서로 섞이지 않는다');
  a.strictEqual(await stillLogin(page), true);
  await page.keyboard.press('Enter'); await page.waitForSelector('#ok');
  a.strictEqual(await stillLogin(page), false, '로그인 뒤에는 로그인 화면이 아니어야 한다');
  await page.close(); await browser.close();
  console.log('tg_ask 입력 점검 통과 (칸 찾기·나눠 넣기·누르기·결과 확인)'); process.exit(0);
})().catch((e) => { console.error('🛑 입력 점검 실패:', e.message); process.exit(1); });
else (async () => {
  const [what, hint = '', min] = process.argv.slice(2);
  const waitMin = Number(min) || 30;
  if (!what) { console.error('사용: node auth/tg_ask.cjs "<무엇이 필요한지>" [탭 주소 일부] [기다릴 분]'); process.exit(1); }

  let ctx = null;
  try { ctx = (await require('../lib/cdp.cjs').connect()).ctx; } catch { /* 크롬이 꺼져 있으면 «요청·대기» 만 한다 */ }

  // 요청 전에 온 옛 글은 답으로 치지 않는다
  const old = await api('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] });
  let offset = old.ok && old.result.length ? old.result[old.result.length - 1].update_id : 0;

  const sent = await say(`🔐 [로그인·인증 요청]\n${what}\n\n`
    + (ctx ? '여기서 바로 넣으시려면 (한 글에 같이 보내셔도 됩니다):\n/아이디 값 /비번 값\n→ 칸에 나눠 넣고 로그인까지 누른 뒤 결과 화면을 보내 드립니다.\n\n/인증 값 · /보안 값 · /화면\n(값이 든 글은 받자마자 지웁니다)\n\n' : '⚠ PC 의 작업 크롬에 연결하지 못했습니다. PC 에서 직접 로그인해 주세요.\n\n')
    + '끝나면 «완료», 그만두려면 «취소» 라고 답해 주세요.');
  if (!sent.ok) { console.error('[전송 실패]', String(sent.description || '').slice(0, 160)); process.exit(1); }
  console.log(`[요청 보냄] ${waitMin}분 동안 답을 기다립니다…`);

  const finish = async (msg, log, code) => { await api('getUpdates', { offset: offset + 1, timeout: 0 }); await say(msg); console.log(log); process.exit(code); };
  const until = Date.now() + waitMin * 60 * 1000;
  while (Date.now() < until) {
    const r = await api('getUpdates', { offset: offset + 1, timeout: 30, allowed_updates: ['message'] });
    if (!r.ok) { await new Promise((s) => setTimeout(s, 5000)); continue; }
    for (const u of r.result || []) {
      offset = Math.max(offset, u.update_id);
      const m = u.message;
      if (!m || String(m.chat?.id) !== OWNER) continue;   // 사장님 글만 본다
      const text = String(m.text || '');
      const items = parseAll(text);
      // 🛑 값이 든 글은 무엇보다 먼저 지운다
      const secret = items.some((x) => ['id', 'pw', 'otp', 'captcha'].includes(x.kind) && x.value);
      const wiped = !secret ? '' : (await api('deleteMessage', { chat_id: OWNER, message_id: m.message_id })).ok ? '보내신 글은 지웠습니다.' : '⚠ 글을 지우지 못했습니다 — 직접 지워 주세요.';
      if (items.some((x) => x.kind === 'done')) await finish('✅ 확인했습니다. 이어서 진행합니다.', '완료', 0);
      if (items.some((x) => x.kind === 'cancel')) await finish('⏹ 취소했습니다. 작업을 멈춥니다.', '취소', 2);
      if (!items.length) { await say('/아이디 · /비번 · /인증 · /보안 · /화면 · /로그인 또는 «완료» · «취소» 로 답해 주세요.'); continue; }
      if (!ctx) { await say(`PC 크롬에 연결돼 있지 않아 넣지 못했습니다. ${wiped}`); continue; }

      const LABEL = { id: '아이디', pw: '비밀번호', otp: '인증번호', captcha: '보안문자' };
      const notes = []; let press = false, failed = false;
      for (const { kind, value } of items) {
        // 화면 사진: «/화면» 또는 값 없는 «/보안» — 보안문자 그림을 폰에서 보시게
        if (kind === 'screen' || (kind === 'captcha' && !value)) {
          let e; try { e = await sendScreen(ctx, hint, kind === 'captcha' ? '보안문자를 보시고 «/보안 답» 으로 보내 주세요.' : '지금 화면입니다.'); } catch (x) { e = '화면 사진 오류: ' + String(x.message).split('\n')[0].slice(0, 120); }
          if (e) notes.push('🛑 ' + e);
          continue;
        }
        if (kind === 'submit') { press = true; continue; }
        if (!value) { notes.push(`🛑 ${LABEL[kind]} 값이 비어 있습니다. 예) /아이디 myid`); failed = true; continue; }
        let err;
        try { err = await fill(ctx, hint, kind, value); } catch (e) { err = '입력 중 오류: ' + String(e.message).split('\n')[0].slice(0, 120); }
        console.log(`[${LABEL[kind]}] ${err ? '실패' : '처리'}`);   // 값은 찍지 않는다
        notes.push(err ? `🛑 ${LABEL[kind]}: ${err}` : `🔑 ${LABEL[kind]} 칸에 넣었습니다.`);
        if (err) failed = true; else if (kind !== 'id') press = true;   // 비번·인증·보안문자까지 들어갔으면 로그인도 여기서 누른다
      }
      if (notes.length || wiped) await say([...notes, wiped].filter(Boolean).join('\n'));
      if (!press || failed) continue;

      // ── 로그인 누르기: 칸이 다 찼는지 «직접 보고» 누른 뒤, 들어갔는지까지 확인한다 ──
      const t = last || await loginPage(ctx, hint);
      if (!t) { await say('🛑 로그인 화면을 찾지 못해 누르지 못했습니다.'); continue; }
      const f = await filled(t);
      if (f && (!f.id || !f.pw)) { await say(`✋ 아직 ${!f.id ? '아이디' : '비밀번호'} 칸이 비어 있어 로그인은 누르지 않았습니다. ${!f.id ? '/아이디' : '/비번'} 를 보내 주세요.`); continue; }
      try { await t.page.bringToFront(); await t.page.keyboard.press('Enter'); } catch (e) { await say('🛑 로그인 누르기 실패: ' + String(e.message).split('\n')[0].slice(0, 120)); continue; }
      console.log('[로그인] 누름');
      await new Promise((s) => setTimeout(s, 5000));
      if (!(await stillLogin(t.page))) {
        try { await sendScreen(ctx, hint, '✅ 로그인됐습니다.'); } catch { /* 사진은 못 보내도 결과는 알린다 */ }
        await finish('✅ 로그인을 확인했습니다. 이어서 진행합니다.', '완료(로그인 확인)', 0);
      }
      try { await sendScreen(ctx, hint, '⚠ 로그인을 눌렀지만 아직 로그인 화면입니다. 보안문자가 보이면 «/보안 답», 값이 틀렸으면 다시 보내 주세요.'); } catch { await say('⚠ 로그인을 눌렀지만 아직 로그인 화면입니다.'); }
    }
  }
  await finish(`⏰ ${waitMin}분 동안 답이 없어 작업을 멈췄습니다.`, '시간 초과', 3);
})();
