# Publishes the TIM-expansion tickets (.scratch/tim-expansion/issues/*.md) to
# GitHub Issues on the fork (origin: abdibr/the-incredible-machine) and wires
# native "blocked by" dependency edges per docs/agents/issue-tracker.md.
#
# Never touches the `upstream` remote.
#
# Idempotent: re-running with -Phase create reuses existing issues by exact
# title match; -Phase deps skips dependency edges that already exist.
#
# Phases (default: all, but run separately to stay under tool timeouts):
#   create -> create the 28 issues with the ready-for-agent label, write NN=num map
#   deps   -> wire native blocked-by edges from each ticket's "Blocked by:" field
#   verify -> compare live issue_dependencies_summary.blocked_by to expectations

param(
    [ValidateSet('all', 'create', 'deps', 'verify')]
    [string]$Phase = 'all',
    [string]$MinNn = '',
    [string]$MaxNn = ''
)

$ErrorActionPreference = 'Stop'

$gh        = 'C:\Program Files\GitHub CLI\gh.exe'
$repo      = 'abdibr/the-incredible-machine'
$dir       = Split-Path -Parent $MyInvocation.MyCommand.Path
$issuesDir = Join-Path $dir 'issues'
$mapFile   = Join-Path $dir 'published-map.txt'
$label     = 'ready-for-agent'

if (-not (Test-Path $gh)) { throw "gh CLI not found at: $gh" }

# Per-ticket 'Blocked by:' fields (ticket NN -> blocker NNs).
# 12 (impact-only path first; rope part gated on 04 in text), 25 (cluster-split
# ticket; sub-ticket blockers are suggestions for the split), 26, 27, and all
# root tickets declare no core blockers -> no native edges.
$deps = [ordered]@{
    '04' = @('02')
    '05' = @('04')
    '09' = @('01', '06')
    '10' = @('04')
    '11' = @('03')
    '13' = @('03')
    '14' = @('13')
    '15' = @('13', '01')
    '16' = @('15', '01')
    '17' = @('06')
    '18' = @('17', '01')
    '19' = @('04')
    '20' = @('17')
    '21' = @('09')
    '23' = @('22')
    '24' = @('01', '04', '17')
    '28' = @('04', '05', '09', '11', '13', '14', '15', '17', '18', '20', '22', '23')
}

# --- shared: map helpers ----------------------------------------------------

function Read-Map {
    if (-not (Test-Path $mapFile)) { throw "map file missing: $mapFile (run -Phase create first)" }
    $m = @{}
    Get-Content $mapFile | ForEach-Object {
        $p = $_.Split('=')
        if ($p.Count -eq 2) { $m[$p[0].Trim()] = [int]$p[1].Trim() }
    }
    return $m
}

# --- create phase -----------------------------------------------------------

function Invoke-Create {
    $existing = @{}
    $raw = & $gh issue list --repo $repo --state open --limit 400 --json number,title
    if ($LASTEXITCODE -ne 0) { throw 'gh issue list failed' }
    ($raw -join "`n") | ConvertFrom-Json | ForEach-Object { $existing[$_.title] = $_.number }
    Write-Output ("existing open issues on {0}: {1}" -f $repo, $existing.Count)

    $map = @{}
    if (Test-Path $mapFile) { $loadedMap = Read-Map; foreach ($k in $loadedMap.Keys) { $map[$k] = $loadedMap[$k] } }
    $files = @(Get-ChildItem $issuesDir -Filter '*.md' | Sort-Object Name)
    if ($files.Count -ne 28) { Write-Output ("WARNING: expected 28 ticket files, found {0}" -f $files.Count) }

    foreach ($file in $files) {
        $nn    = ($file.BaseName -split '-')[0]          # '01' .. '28'
        if ($MinNn -and [int]$nn -lt [int]$MinNn) { continue }
        if ($MaxNn -and [int]$nn -gt [int]$MaxNn) { continue }
        $text  = Get-Content $file.FullName -Raw -Encoding UTF8
        $lines = $text -split "`r?`n"
        $title = ($lines[0] -replace '^#\s+', '')

        if ($existing.ContainsKey($title)) {
            $num = $existing[$title]
            Write-Output ("{0}: already exists as #{1}" -f $nn, $num)
        } else {
            $i = 1
            while ($i -lt $lines.Count -and $lines[$i].Trim() -eq '') { $i++ }
            $body = ($lines | Select-Object -Skip $i) -join "`n"
            $tmp  = Join-Path $env:TEMP ("tim-ticket-body-$nn.md")
            [System.IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding($false)))

            $out = & $gh issue create --repo $repo --title $title --body-file $tmp --label $label
            if ($LASTEXITCODE -ne 0) { throw ("gh issue create failed for ticket {0}" -f $nn) }
            $m = [regex]::Match(($out -join ' '), 'issues/(\d+)')
            if (-not $m.Success) { throw ("could not parse issue url for ticket {0}: {1}" -f $nn, ($out -join ' ')) }
            $num = [int]$m.Groups[1].Value
            Remove-Item $tmp -ErrorAction SilentlyContinue
            Write-Output ("{0}: created #{1}  {2}" -f $nn, $num, $title)
        }
        $map[$nn] = $num
    }

    $mapText = ($map.Keys | Sort-Object | ForEach-Object { '{0}={1}' -f $_, $map[$_] }) -join "`r`n"
    [System.IO.File]::WriteAllText($mapFile, $mapText + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ("map written: {0}" -f $mapFile)
}

# --- deps phase ---------------------------------------------------------------

function Invoke-Deps {
    $map = Read-Map
    $pending = 0; $wired = 0; $already = 0; $failed = @()
    $blockerIds = @{}

    foreach ($childNn in $deps.Keys) {
        if ($MinNn -and [int]$childNn -lt [int]$MinNn) { continue }
        if ($MaxNn -and [int]$childNn -gt [int]$MaxNn) { continue }
        if (-not $map.Contains($childNn)) { throw ("map missing ticket {0}" -f $childNn) }
        $child = [int]$map[$childNn]

        # Fetch the child's existing blocked-by ids once per child (idempotency).
        $listOut = & $gh api "repos/$repo/issues/$child/dependencies/blocked_by" --jq '.[].id'
        $existingIds = @()
        if ($LASTEXITCODE -eq 0) { $existingIds = @($listOut) }

        foreach ($blockerNn in $deps[$childNn]) {
            $pending++
            if (-not $map.Contains($blockerNn)) { throw ("map missing blocker {0}" -f $blockerNn) }
            $blocker = [int]$map[$blockerNn]

            if (-not $blockerIds.ContainsKey($blockerNn)) {
                $idOut = & $gh api "repos/$repo/issues/$blocker" --jq '.id'
                if ($LASTEXITCODE -ne 0) { $failed += ("edge #{0}<-{1}: could not fetch blocker db id" -f $child, $blocker); continue }
                $blockerIds[$blockerNn] = "$idOut".Trim()
            }
            $blockerId = $blockerIds[$blockerNn]

            if ($existingIds -contains $blockerId) {
                $already++
                Write-Output ("#{0}: already blocked by #{1}" -f $child, $blocker)
                continue
            }

            $null = & $gh api --method POST "repos/$repo/issues/$child/dependencies/blocked_by" -F "issue_id=$blockerId"
            if ($LASTEXITCODE -eq 0) {
                $wired++
                Write-Output ("#{0}: wired blocked_by #{1}" -f $child, $blocker)
            } else {
                $failed += ("edge #{0}<-{1}: POST failed" -f $child, $blocker)
            }
        }
    }

    Write-Output ("edges: {0} expected / {1} wired / {2} already present / {3} failed" -f $pending, $wired, $already, $failed.Count)
    if ($failed.Count -gt 0) {
        $failed | ForEach-Object { Write-Output ("FAILED: {0}" -f $_) }
        throw 'dependency wiring had failures'
    }
}

# --- verify phase -------------------------------------------------------------

function Invoke-Verify {
    $map = Read-Map
    $bad = 0
    foreach ($nn in ($map.Keys | Sort-Object)) {
        if ($MinNn -and [int]$nn -lt [int]$MinNn) { continue }
        if ($MaxNn -and [int]$nn -gt [int]$MaxNn) { continue }
        $num = [int]$map[$nn]
        $expected = 0
        if ($deps.Contains($nn)) { $expected = @($deps[$nn]).Count }

        $sumOut = & $gh api "repos/$repo/issues/$num" --jq '(.issue_dependencies_summary.blocked_by // 0)'
        if ($LASTEXITCODE -ne 0) { $bad++; Write-Output ("{0} #{1}: verify call FAILED" -f $nn, $num); continue }
        $got = 0
        [void][int]::TryParse("$sumOut".Trim(), [ref]$got)
        $tag = 'ok'
        if ($got -ne $expected) { $tag = 'MISMATCH'; $bad++ }
        Write-Output ("{0} #{1}: blocked_by {2}/{3} {4}" -f $nn, $num, $got, $expected, $tag)
    }
    if ($bad -gt 0) { throw ("verification mismatches: {0}" -f $bad) }
    Write-Output 'verification: all edges match expectations'
}

# --- run ----------------------------------------------------------------------

if ($Phase -in @('all', 'create')) { Invoke-Create }
if ($Phase -in @('all', 'deps'))   { Invoke-Deps }
if ($Phase -in @('all', 'verify')) { Invoke-Verify }

Write-Output ('publish.ps1: done (phase={0})' -f $Phase)