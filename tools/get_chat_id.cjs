// 봇에게 글을 보낸 사람들의 chat_id 를 보여 준다 → .env 의 TELEGRAM_CHAT_ID 에 적는다
// 사용: 텔레그램에서 링크드 봇에게 아무 글이나 보낸 뒤  npm run chat-id
require('../lib/env.cjs');
const TOKEN = process.env.HQ_TG_BOT_TOKEN || process.env.AUTH_TG_BOT_TOKEN;
if (!TOKEN) { console.error('🛑 먼저 .env 에 HQ_TG_BOT_TOKEN 을 넣어 주세요'); process.exit(1); }
(async () => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates`).then((x) => x.json());
  if (!r.ok) { console.error('🛑 토큰이 틀렸거나 브릿지가 이미 돌고 있습니다:', r.description); process.exit(1); }
  const seen = new Map();
  for (const u of r.result) { const c = u.message?.chat; if (c) seen.set(c.id, `${c.first_name || ''} ${c.last_name || ''} @${c.username || ''}`.trim()); }
  if (!seen.size) console.log('아직 받은 글이 없습니다. 텔레그램에서 봇에게 «안녕» 을 보내고 다시 실행하세요.');
  for (const [id, who] of seen) console.log(`chat_id ${id}   ← ${who}`);
})();
