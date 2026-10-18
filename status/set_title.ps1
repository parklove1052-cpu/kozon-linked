# 훅에서 부른 프로세스는 Claude 와 다른(숨은) 콘솔에 붙어 있다.
# 그래서 위로 올라가 claude.exe 를 찾고, 그 콘솔에 붙어서 창 제목을 바꾼다.
# 제목이 바뀌면 VS코드가 ${sequence} 로 받아 탭 이름에 띄운다.
#   powershell -File set_title.ps1 "<탭 제목>"
param([string]$Title)
Add-Type -Namespace K -Name Con -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(int pid);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool SetConsoleTitleW(string t);
'@
$p = $PID; $target = 0
while ($p) {
  $x = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if (-not $x) { break }
  if ($x.Name -eq 'claude.exe') { $target = $x.ProcessId; break }
  $p = $x.ParentProcessId
}
if (-not $target) { exit 3 }
[K.Con]::FreeConsole() | Out-Null
if (-not [K.Con]::AttachConsole($target)) { exit 4 }
if (-not [K.Con]::SetConsoleTitleW($Title)) { exit 5 }
exit 0
