# 링크드 (kozon-linked)

폰 텔레그램으로 PC 의 Claude Code 에게 일을 시키는 시스템. 세 부분이다.

| | 이름 | 하는 일 | 파일 |
|---|---|---|---|
| ① | **링크드 브릿지** | 폰 글 → 이 PC 의 Claude Code 가 실행 → 결과를 폰으로 | `bridge/tg_bridge.cjs` |
| ③ | **비밀번호 링크드봇** | 로그인·인증이 필요할 때 폰으로 요청 → 받은 값을 작업 크롬 로그인 칸에 넣고, 받은 글은 바로 지움 | `auth/tg_ask.cjs` |
| ④ | **알림** | 진행·문제를 텔레그램으로 보고 | `notify/notify.cjs` |

비밀값(봇 토큰·chat_id)은 리포에 없다. 설치하는 PC 에서 `.env` 에 넣는다.

## 설치 (새 PC, 10분)

준비물: Windows · [Node.js LTS](https://nodejs.org) · 크롬 · Claude Code(`irm https://claude.ai/install.ps1 | iex` 후 `claude` 한 번 실행해 로그인)

1. 텔레그램 **@BotFather** 에서 `/newbot` 으로 봇을 **두 개** 만든다 — 링크드용, 비밀번호용. 🛑 같은 봇을 두 용도로 쓰지 않는다(쓰면 비밀번호가 Claude 대화로 들어간다).
2. 받기:
   ```powershell
   git clone https://github.com/parklove1052-cpu/kozon-linked.git C:\kozon\kozon-linked
   cd C:\kozon\kozon-linked
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
   메모장이 열리면 `HQ_TG_BOT_TOKEN` · `AUTH_TG_BOT_TOKEN` 을 넣고 저장한다.
3. 텔레그램에서 두 봇을 열고 **«시작»** 을 누른다. 링크드 봇에게 «안녕» 을 보낸 뒤 `npm run chat-id` → 나온 번호를 `.env` 의 `TELEGRAM_CHAT_ID` 에 넣는다.
4. `.env` 의 `WORK_DIR` 에 Claude 가 일할 폴더(헤드쿼터스, `CLAUDE.md` 있는 곳)를 적는다. 비우면 `workspace\` 를 쓴다.
5. 켜기: `bridge\start_bridge.cmd` — 폰에 «브릿지를 켰습니다» 가 오면 끝. 설치 스크립트가 시작프로그램에도 넣어 두어 윈도우 로그인 때 저절로 켜진다.

🛑 PC 가 절전에 들어가면 멈춘다 → 전원 옵션에서 «전원 연결 시 절전: 안 함».
🛑 같은 봇을 두 PC 에서 동시에 켜면 둘 다 멈춘다(텔레그램 409). PC 마다 봇을 따로 만들거나 한쪽을 끈다.

## 폰에서 쓰는 법

**링크드 봇**
- 그냥 쓰기 = 이전 대화에 이어서 · `/새로 …` = 새 대화 · `/상태` = 살아 있나 · `/취소` = 하던 일 끊기(되돌리지 않음, 줄 선 글도 취소)
- 글을 받으면 바로 «확인했습니다» → 온 순서대로 하나씩 실행 · 15분마다 «아직 돌고 있습니다» · 3시간 넘으면 끊음
- 사진·파일(PDF·엑셀 등, 20MB 까지)은 «확인되었습니다» 만 답하고 다음 글과 함께 읽는다
- 꺼져 있는 동안 온 글은 실행하지 않고 넘긴다(켜자마자 옛 일을 다시 하지 않게)
- `/할일` · `/할일 추가` — 할 일 판(`todo.cjs`)이 있을 때만(`.env` 의 `TODO_JS`)

**비밀번호 봇** — Claude(또는 스크립트)가 부른다
```
node auth/tg_ask.cjs "<무엇이 필요한지>" <탭 주소 일부> [기다릴 분=30]
```
- 폰에서 `/아이디 값 /비번 값` → 작업 크롬 로그인 칸에 나눠 넣고 로그인 누르고 결과 화면 사진을 보냄. 값이 든 글은 받자마자 지움
- `/인증 값` · `/보안 값`(값 없이 `/보안` = 화면 사진) · `/화면` · `완료` · `취소`
- 종료코드: 0 완료(로그인 확인) · 2 취소 · 3 시간 초과 · 1 설정 오류
- 작업 크롬: `chrome\work_chrome.cmd` (CDP 9888, 프로필 `data\chrome_profile`). 이 크롬에 사이트별로 로그인해 두고 쓴다.

**알림**
```
node notify/notify.cjs text "<글 또는 파일>"
node notify/notify.cjs photo <이미지> [캡션]
```

## 구조

```
bridge/tg_bridge.cjs     텔레그램 긴 폴링 → claude -p (bypass 권한, --resume 으로 브릿지 전용 대화 이어감)
bridge/start_bridge.cmd  죽으면 10초 뒤 다시 켜는 창
auth/tg_ask.cjs          요청 → 답 기다림 → Playwright 로 작업 크롬 입력칸에 타이핑
notify/notify.cjs        글·사진 보내기
lib/env.cjs              리포 맨 위 .env 읽기
lib/cdp.cjs              작업 크롬(CDP) 연결
tools/get_chat_id.cjs    chat_id 확인
install.ps1              설치·점검·시작프로그램 등록
data/                    (자동 생성, 안 올라감) 상태 파일·기록 tg_bridge.log·받은 파일·크롬 프로필
```

## 보안

- 브릿지는 `TELEGRAM_CHAT_ID` 에서 온 글만 실행한다. 권한이 bypass 라 **이것이 유일한 방어선** — 토큰이 새면 PC 가 열린다. 새면 @BotFather `/revoke`.
- 비밀번호 값은 프로세스 메모리 → 크롬 입력칸으로만 간다. 파일·로그·Claude 대화에 남기지 않는다. 다만 텔레그램 봇 대화는 종단간 암호화가 아니다.
- `.env` 는 `.gitignore` 에 있다. 커밋하지 않는다.

## 점검

```
npm test                         # 브릿지 22건 + 비밀번호 봇 15건
node auth/tg_ask.cjs --formtest  # 작업 크롬을 켠 상태에서: 칸 찾기·입력·로그인·결과 확인
```
