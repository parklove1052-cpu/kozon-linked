# =====================================================================
# statusline.ps1 - Claude Code statusLine command
# =====================================================================
# Wired into your Claude Code global settings.json:
#   "statusLine": { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <path>\\statusline.ps1" }
#
# stdin: JSON payload from Claude Code (workspace.current_dir, model, ...)
# stdout: single-line text shown in the bottom-right corner.
# Must be fast (no external IO).
# =====================================================================

$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

# ANSI: 24-bit dark blue background + bold white text = "blue box"
$esc = [char]27
$reset = "$esc[0m"
$blueBox = "$esc[1m$esc[48;2;30;64;175m$esc[97m"

try {
    # Read stdin as raw bytes then UTF-8 decode (avoids cp949 conversion)
    $stdin = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $buf = New-Object byte[] 4096
    while (($n = $stdin.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
    $input_json = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    $payload = $input_json | ConvertFrom-Json

    $cwd = $null
    if ($payload.workspace -and $payload.workspace.current_dir) {
        $cwd = $payload.workspace.current_dir
    } elseif ($payload.cwd) {
        $cwd = $payload.cwd
    } else {
        $cwd = (Get-Location).Path
    }

    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $configPath = Join-Path $scriptDir 'domain-config.json'
    if (-not (Test-Path $configPath)) {
        # 도메인 목록이 없으면 …\domains\<방> 의 방 이름, 아니면 폴더 이름
        $room = if ($cwd -match '[\\/]domains[\\/]([^\\/]+)') { $Matches[1] } else { Split-Path -Leaf $cwd }
        $modelName = if ($payload.model -and $payload.model.display_name) { $payload.model.display_name } else { '' }
        $boxed = "$blueBox  📂 $room  $reset"
        if ($modelName) { Write-Output "$boxed  ·  $modelName" } else { Write-Output $boxed }
        exit 0
    }

    $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    # Follow junctions so Documents\X and OneDrive\Documents\X count as one folder
    function Resolve-RealPath {
        param([string]$Path)
        $parts = $Path.TrimEnd('\') -split '\\'
        $cur = $parts[0] + '\'
        for ($i = 1; $i -lt $parts.Count; $i++) {
            $cur = Join-Path $cur $parts[$i]
            $item = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
            if ($item -and ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') -and $item.Target) {
                $cur = @($item.Target)[0]
            }
        }
        return $cur.TrimEnd('\').ToLower()
    }
    $cwdNormalized = Resolve-RealPath $cwd

    $matched = $null
    foreach ($d in $config.domains) {
        $domainPath = Resolve-RealPath (Join-Path $config.domainsRoot $d.folder)
        if ($cwdNormalized -eq $domainPath -or $cwdNormalized.StartsWith($domainPath + '\')) {
            $matched = $d
            break
        }
    }

    $modelName = if ($payload.model -and $payload.model.display_name) { $payload.model.display_name } else { '' }

    if ($matched) {
        $boxed = "$blueBox  $($matched.icon) $($matched.name)  $reset"
    } else {
        $workspaceLabel = if ($config.workspaceName) { $config.workspaceName } else { 'workspace' }
        $boxed = "$blueBox  📂 $workspaceLabel  $reset"
    }

    if ($modelName) {
        Write-Output "$boxed  ·  $modelName"
    } else {
        Write-Output $boxed
    }
} catch {
    Write-Output "$blueBox  📂  $reset"
    exit 0
}
