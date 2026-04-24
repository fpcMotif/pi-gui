$ErrorActionPreference = "Stop"

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory=$true)][string]$LogPath,
    [Parameter(Mandatory=$true)][scriptblock]$Command
  )

  & $Command *> $LogPath
  if ($LASTEXITCODE -ne 0) {
    Get-Content -Path $LogPath -Tail 80
    exit $LASTEXITCODE
  }
}

Invoke-CheckedCommand -LogPath "$env:TEMP\pi-gui-autoresearch-typecheck.log" -Command {
  pnpm typecheck
}

$packageJsonFiles = Get-ChildItem -Path "packages" -Filter "package.json" -Recurse -Depth 2 | Sort-Object FullName
foreach ($packageJson in $packageJsonFiles) {
  $packageDir = $packageJson.Directory.FullName
  $tests = Get-ChildItem -Path (Join-Path $packageDir "tests") -Filter "*.test.mjs" -ErrorAction SilentlyContinue
  if (-not $tests) {
    continue
  }

  Invoke-CheckedCommand -LogPath "$env:TEMP\pi-gui-autoresearch-unit.log" -Command {
    pnpm --dir $packageDir test
  }
}

Invoke-CheckedCommand -LogPath "$env:TEMP\pi-gui-autoresearch-core.log" -Command {
  pnpm --filter "@pi-gui/desktop" run test:e2e:core
}
