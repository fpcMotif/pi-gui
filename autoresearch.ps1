$ErrorActionPreference = "Stop"

function Get-PlaywrightTestCount {
  param([Parameter(Mandatory=$true)][string]$Scope)

  $output = pnpm --filter "@pi-gui/desktop" run test:e2e:runner -- --list --reporter=line $Scope 2>&1
  if ($LASTEXITCODE -ne 0) {
    $output | Write-Output
    throw "Playwright list failed for $Scope"
  }

  foreach ($line in $output) {
    if ($line -match '^Total:\s+(\d+)\s+tests?\b') {
      return [int]$Matches[1]
    }
  }

  throw "Could not parse Playwright test count for $Scope"
}

function Get-NodeUnitTestCount {
  $total = 0
  $packageJsonFiles = Get-ChildItem -Path "packages" -Filter "package.json" -Recurse -Depth 2 | Sort-Object FullName
  foreach ($packageJson in $packageJsonFiles) {
    $packageDir = $packageJson.Directory.FullName
    $tests = Get-ChildItem -Path (Join-Path $packageDir "tests") -Filter "*.test.mjs" -ErrorAction SilentlyContinue | Sort-Object FullName
    if (-not $tests) {
      continue
    }

    $output = node --test --test-reporter=spec @($tests.FullName) 2>&1
    if ($LASTEXITCODE -ne 0) {
      $output | Write-Output
      throw "Node unit test listing failed for $packageDir"
    }

    foreach ($line in $output) {
      if ($line -match '^\s+✔\s+') {
        $total += 1
      }
    }
  }
  return $total
}

$coreE2eTests = Get-PlaywrightTestCount "apps/desktop/tests/core"
$liveE2eTests = Get-PlaywrightTestCount "apps/desktop/tests/live"
$nativeE2eTests = Get-PlaywrightTestCount "apps/desktop/tests/native"
$unitTestCases = Get-NodeUnitTestCount
$qualityPoints = $coreE2eTests + $liveE2eTests + $nativeE2eTests + $unitTestCases

Write-Output "METRIC quality_points=$qualityPoints"
Write-Output "METRIC core_e2e_tests=$coreE2eTests"
Write-Output "METRIC live_e2e_tests=$liveE2eTests"
Write-Output "METRIC native_e2e_tests=$nativeE2eTests"
Write-Output "METRIC unit_test_cases=$unitTestCases"
