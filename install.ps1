# 링크드 설치 — 이 폴더에서:  powershell -ExecutionPolicy Bypass -File install.ps1
#   -NoStartup : 윈도우 로그인 때 자동으로 켜지게 하지 않는다
#   -NoStatus  : 상태 표시(탭 점·상태줄)를 Claude 설정에 넣지 않는다
param([switch]$NoStartup, [switch]$NoStatus)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }

Write-Host "`n== 링크드 설치 ==`n"

# 1) Node.js 20 이상
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Bad "Node.js 가 없습니다 → https://nodejs.org 에서 LTS 를 설치하고 다시 실행하세요"; exit 1 }
$v = (node -v).TrimStart('v').Split('.')[0]
if ([int]$v -lt 20) { Bad "Node.js $(node -v) 는 오래됐습니다. 20 이상을 설치하세요"; exit 1 }
Ok "Node.js $(node -v)"

# 2) Claude Code
$claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
if (Test-Path $claude) { Ok "Claude Code $claude" }
else {
  Bad "Claude Code 가 없습니다 → 파워셸에서:  irm https://claude.ai/install.ps1 | iex"
  Bad "설치 뒤 claude 를 한 번 실행해 로그인하세요 (다른 위치면 .env 의 CLAUDE_EXE 에 적기)"
}

# 3) 패키지 (크롬은 이미 깔린 것을 쓰므로 Playwright 브라우저는 받지 않는다)
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm install --no-audit --no-fund | Out-Null
Ok "npm 패키지 설치"

# 4) .env
if (-not (Test-Path "$Root\.env")) {
  Copy-Item "$Root\.env.example" "$Root\.env"
  Bad ".env 를 만들었습니다 — 메모장이 열리면 토큰을 채우고 저장하세요"
  Start-Process notepad "$Root\.env" -Wait
}
Ok ".env 있음"

# 5) 자체점검
node bridge/tg_bridge.cjs --selftest
node auth/tg_ask.cjs --selftest

# 6) 상태 표시 (탭 점 🔴🟡🟢 · 아래 상태줄 · VS Code 탭 이름) — -NoStatus 면 건너뜀
if (-not $NoStatus) { node status/apply_settings.cjs }

# 7) 윈도우 로그인 때 브릿지 자동 시작
if (-not $NoStartup) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) '링크드 브릿지.lnk'
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = "$Root\bridge\start_bridge.cmd"
  $s.WorkingDirectory = $Root
  $s.Save()
  Ok "시작프로그램 등록: $lnk"
}

Write-Host "`n== 다음 =="
Write-Host "  1. 텔레그램에서 링크드 봇·비밀번호 봇을 열고 «시작» 을 누른다"
Write-Host "  2. chat_id 를 모르면:  npm run chat-id   → .env 의 TELEGRAM_CHAT_ID 에 적기"
Write-Host "  3. 브릿지 켜기:  bridge\start_bridge.cmd"
Write-Host "  4. 비밀번호 봇을 쓰려면 작업 크롬:  chrome\work_chrome.cmd"
Write-Host "  🛑 PC 가 절전에 들어가면 링크드가 멈춘다 → 전원 설정에서 절전 «안 함»`n"
