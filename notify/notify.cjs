// 텔레그램 알림 보내기 (진행·문제 보고용)
// 사용: node notify/notify.cjs text <파일|글>
//       node notify/notify.cjs photo <이미지파일> [캡션]
// 토큰은 .env 의 TELEGRAM_BOT_TOKEN(알림봇), 없으면 HQ_TG_BOT_TOKEN(링크드봇). 받는 곳은 TELEGRAM_CHAT_ID.
const fs = require('node:fs');
const path = require('node:path');
require('../lib/env.cjs');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.HQ_TG_BOT_TOKEN;
const CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
if (!TOKEN || !CHAT) { console.error('🛑 .env 에 봇 토큰 / TELEGRAM_CHAT_ID 가 필요합니다'); process.exit(1); }

const [kind, a, b] = process.argv.slice(2);
(async () => {
  let res;
  if (kind === 'text') {
    const text = fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : String(a || '');
    for (let i = 0; i < text.length; i += 3500) {
      res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT, text: text.slice(i, i + 3500), disable_web_page_preview: true }),
      }).then((r) => r.json());
    }
  } else if (kind === 'photo') {
    const form = new FormData();
    form.append('chat_id', CHAT);
    if (b) form.append('caption', String(b).slice(0, 1000));
    form.append('photo', new Blob([fs.readFileSync(a)]), path.basename(a));
    res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: form }).then((r) => r.json());
  } else {
    console.error('사용: node notify/notify.cjs text <파일|글>  |  photo <이미지> [캡션]'); process.exit(1);
  }
  if (!res || !res.ok) { console.error('[전송 실패]', JSON.stringify(res).slice(0, 200)); process.exit(1); }
  console.log('보냄');
})();
