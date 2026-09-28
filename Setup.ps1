$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  & npm.cmd ci --ignore-scripts --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
  & npm.cmd run doctor
  if ($LASTEXITCODE -ne 0) { throw 'Readiness check failed.' }
} finally { Pop-Location }
