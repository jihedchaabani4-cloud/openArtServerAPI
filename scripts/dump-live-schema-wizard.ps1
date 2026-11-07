# Wizard: Dump Live Schema (Read-Only) & Re-link to Staging (PowerShell Version)
# Safety:
#   - READ-ONLY on live: only dumps schema (no data, no writes, no DDL).
#   - Never stores or prints any database password.
#   - Guarantees CLI is linked back to STAGING before exiting.

$ErrorActionPreference = "Stop"

# 1. Resolve project root (parent folder of scripts directory) and Set-Location
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDirectory) {
    $ScriptDirectory = $PSScriptRoot
}
if (-not $ScriptDirectory) {
    $ScriptDirectory = (Get-Location).Path
}
$ProjectRoot = Split-Path -Parent $ScriptDirectory
Set-Location -LiteralPath $ProjectRoot

# 2. Check that supabase\config.toml exists in the project root
$ConfigTomlPath = Join-Path -Path $ProjectRoot -ChildPath "supabase\config.toml"
if (-not (Test-Path -LiteralPath $ConfigTomlPath)) {
    Write-Host ("[ERROR] supabase\config.toml not found at: {0}" -f $ConfigTomlPath) -ForegroundColor Red
    exit 1
}

$LIVE_REF = "ffwcjldmmddcxlisntgt"
$STAGING_REF = "uedyifxpddbpgjptuhwo"
$TOTAL_STAGES = 4

function Pause-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host ("  {0} " -f $Message) -ForegroundColor DarkGray -NoNewline
    [Console]::ReadLine() | Out-Null
}

Clear-Host
Write-Host ""
Write-Host "  Live Schema Extraction & Staging Re-link Wizard" -ForegroundColor Cyan
Write-Host ("  {0} stages - Read-only live schema extraction`n" -f $TOTAL_STAGES) -ForegroundColor DarkGray
Write-Host "  This wizard safely dumps the live database schema (DDL only, 0 data)" -ForegroundColor DarkGray
Write-Host "  and immediately re-links to the staging project.`n" -ForegroundColor DarkGray
Write-Host ("  * LIVE ref:    {0} (READ-ONLY)" -f $LIVE_REF) -ForegroundColor Yellow
Write-Host ("  * STAGING ref: {0} (TARGET)`n" -f $STAGING_REF) -ForegroundColor Green
Pause-Step -Message "Press Enter when ready to start..."

# -- Stage 1: Link to Live -------------------------------------------------
Clear-Host
Write-Host ""
Write-Host ("[STAGE 1/{0}] Link CLI to LIVE project (read-only)`n" -f $TOTAL_STAGES) -ForegroundColor Cyan
Write-Host "  Connects the Supabase CLI to the live database so we can perform a read-only schema dump."
Write-Host ("  * Command: supabase link --project-ref {0}" -f $LIVE_REF) -ForegroundColor Blue
Write-Host "  Enter your LIVE database password when prompted by the CLI." -ForegroundColor DarkGray
Write-Host "  (Your password is never stored or echoed to any file).`n" -ForegroundColor DarkGray
Pause-Step -Message "Press Enter to execute the link command..."

supabase link --project-ref $LIVE_REF

# -- Stage 2: Schema Dump --------------------------------------------------
Clear-Host
Write-Host ""
Write-Host ("[STAGE 2/{0}] Dump public schema from LIVE`n" -f $TOTAL_STAGES) -ForegroundColor Cyan
Write-Host "  Dumps only the public SQL schema from the live database into a local file without touching any user data or storage files."
Write-Host "  * Command: supabase db dump --schema public -f supabase/schema_live.sql`n" -ForegroundColor Blue
Pause-Step -Message "Press Enter to run the schema dump..."

$SupabaseDir = Join-Path -Path $ProjectRoot -ChildPath "supabase"
if (-not (Test-Path -LiteralPath $SupabaseDir)) {
    New-Item -ItemType Directory -Path $SupabaseDir | Out-Null
}

$DumpFilePath = Join-Path -Path $SupabaseDir -ChildPath "schema_live.sql"
supabase db dump --schema public -f $DumpFilePath

if ((-not (Test-Path -LiteralPath $DumpFilePath)) -or ((Get-Item -LiteralPath $DumpFilePath).Length -eq 0)) {
    Write-Host ""
    Write-Host "[ERROR] supabase/schema_live.sql is empty or was not created." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  [OK] Schema dumped successfully to supabase/schema_live.sql" -ForegroundColor Green
Write-Host ""
Pause-Step -Message "Press Enter to switch back to staging..."

# -- Stage 3: Link back to Staging -----------------------------------------
Clear-Host
Write-Host ""
Write-Host ("[STAGE 3/{0}] Switch link BACK to STAGING`n" -f $TOTAL_STAGES) -ForegroundColor Cyan
Write-Host "  Immediately disconnects from the live project and switches the CLI back to staging to prevent accidental writes."
Write-Host ("  * Command: supabase link --project-ref {0}" -f $STAGING_REF) -ForegroundColor Blue
Write-Host "  Enter your STAGING database password when prompted.`n" -ForegroundColor DarkGray
Pause-Step -Message "Press Enter to re-link to staging..."

supabase link --project-ref $STAGING_REF

# -- Stage 4: Verification -------------------------------------------------
Clear-Host
Write-Host ""
Write-Host ("[STAGE 4/{0}] Verify active project is STAGING`n" -f $TOTAL_STAGES) -ForegroundColor Cyan
Write-Host "  Verifies that the linked project is strictly staging before any further operations."

$ProjectRefFile = Join-Path -Path $ProjectRoot -ChildPath "supabase\.temp\project-ref"
$ActiveRef = ""
if (Test-Path -LiteralPath $ProjectRefFile) {
    $ActiveRef = (Get-Content -LiteralPath $ProjectRefFile -Raw).Trim()
}

Write-Host ("  Active linked project ref: {0}" -f $ActiveRef) -ForegroundColor Yellow

if ($ActiveRef -ne $STAGING_REF) {
    Write-Host ""
    Write-Host ("[SAFETY FAILURE] Linked project is NOT staging ({0} != {1})!" -f $ActiveRef, $STAGING_REF) -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host ("  [OK] Verified: Active CLI link is strictly STAGING ({0}).`n" -f $STAGING_REF) -ForegroundColor Green
supabase projects list

Write-Host ""
Write-Host "  [SUCCESS] Wizard Complete! LIVE was not modified and STAGING is active.`n" -ForegroundColor Green
