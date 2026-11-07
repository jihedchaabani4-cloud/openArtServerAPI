param([Parameter(Mandatory=$true)][string]$Commit)
# Runs `npm run gate` in an isolated throwaway worktree.
# Places the worktree in $env:TEMP alongside tracked supabase/migrations to eliminate dirty-parent effects.
# node_modules is junctioned from the main checkout; no .env is copied.

$ErrorActionPreference = "Stop"
$apiRepo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$randId = [System.Guid]::NewGuid().ToString("N").Substring(0, 8)
$isolatedRoot = Join-Path $env:TEMP ("gate-iso-" + $randId)
$wt = Join-Path $isolatedRoot "apiOpenArt"

try {
    # Add detached worktree for apiOpenArt (includes tracked supabase/migrations)
    git -C $apiRepo worktree add --detach $wt $Commit | Out-Null

    # Junction node_modules
    New-Item -ItemType Junction -Path (Join-Path $wt "node_modules") -Target (Join-Path $apiRepo "node_modules") | Out-Null

    Push-Location $wt
    Write-Output ("WORKTREE HEAD: " + (git rev-parse --short HEAD) + "  status-lines: " + ((git status --porcelain | Measure-Object).Count))
    npm run gate 2>&1 | Select-String -Pattern "GATE SUMMARY|^PASS|^FAIL|^SKIP|RESULT|^---|not ok|Error" | ForEach-Object { $_.Line }
    Pop-Location
} finally {
    if (Test-Path (Join-Path $wt "node_modules")) {
        cmd /c rmdir (Join-Path $wt "node_modules") 2>&1 | Out-Null
    }
    git -C $apiRepo worktree remove --force $wt 2>&1 | Out-Null
    if (Test-Path $isolatedRoot) {
        Remove-Item -Path $isolatedRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
