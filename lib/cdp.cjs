// 작업 크롬(CDP 포트, 기본 9888)에 붙는다. 로그인은 그 크롬에서 사람이 한다.
require('./env.cjs');
const { chromium } = require('playwright');
const PORT = Number(process.env.CDP_PORT || 9888);
async function connect() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  return { browser, ctx: browser.contexts()[0] };
}
module.exports = { connect, PORT };
