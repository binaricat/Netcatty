# Build a static EternalTerminal `et` client on Windows (x64, MSVC).
#
# Inputs (env):
#   ET_REF   — git ref of MisterTea/EternalTerminal to build (e.g. et-v6.2.10)
#   OUT_DIR  — directory to write et-win32-x64.tar.gz + sha256
#
# Output:
#   $OUT_DIR/et-win32-x64.tar.gz          (single static et.exe, no DLLs)
#   $OUT_DIR/et-win32-x64.tar.gz.sha256
#
# Uses the vendored vcpkg x64-windows-static triplet so the produced et.exe
# statically links the MSVC runtime and all third-party deps — no DLL bundle
# is needed. Run from a Developer Command Prompt (ilammy/msvc-dev-cmd) so
# cl.exe / ninja are on PATH.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $env:ET_REF) { throw "missing ET_REF" }
if (-not $env:OUT_DIR) { throw "missing OUT_DIR" }

$etRef = $env:ET_REF
if ($etRef -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $etRef -match '\.\.' -or $etRef -match '@\{' -or $etRef.EndsWith('/') -or $etRef.EndsWith('.lock')) {
  throw "invalid ET_REF: $etRef"
}

# Root the build just under the drive root. vcpkg unpacks dependencies into
# <work>\et\external_imported\vcpkg\buildtrees\... and libsodium's bundled
# MSBuild project pulls sources via long "..\..\..\..\src\..." relative paths.
# Rooted in %TEMP% (~60 chars) the unnormalized path exceeds Windows MAX_PATH
# (260) and fails with "C1083: Cannot open source file". A short drive-root
# (e.g. C:\et-XXXXXXXX) keeps every path comfortably under the limit.
$work = "$env:SystemDrive\et-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8)
if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $work | Out-Null
New-Item -ItemType Directory -Force -Path $env:OUT_DIR | Out-Null

try {
  $etDir = Join-Path $work "et"
  git init $etDir
  git -C $etDir remote add origin https://github.com/MisterTea/EternalTerminal.git
  git -C $etDir fetch --depth 1 origin $etRef
  git -C $etDir checkout --detach FETCH_HEAD
  git -C $etDir submodule update --init --recursive --depth 1

  # Drop sentry-native from the vcpkg manifest. We configure with
  # -DDISABLE_TELEMETRY=ON so ET never references Sentry, but vcpkg's manifest
  # mode would still force-build it (and crashpad). Removing it avoids an
  # unused heavy dependency and speeds up the build.
  $manifest = Join-Path $etDir "vcpkg.json"
  if (-not (Select-String -Path $manifest -Pattern '"sentry-native"' -Quiet)) {
    throw "sentry-native not in vcpkg.json (ET manifest changed?)"
  }
  (Get-Content $manifest) | Where-Object { $_ -notmatch '"sentry-native"' } | Set-Content $manifest

  # Build only the Release halves of the vcpkg deps (skip Debug) to roughly
  # halve build time, via an overlay triplet mirroring x64-windows-static but
  # forcing release-only.
  $overlay = Join-Path $work "vcpkg-overlay-triplets"
  New-Item -ItemType Directory -Force -Path $overlay | Out-Null
  $srcTriplet = Join-Path $etDir "external\vcpkg\triplets\x64-windows-static.cmake"
  if (-not (Test-Path $srcTriplet)) {
    $srcTriplet = Join-Path $etDir "external\vcpkg\triplets\community\x64-windows-static.cmake"
  }
  if (-not (Test-Path $srcTriplet)) { throw "vcpkg triplet x64-windows-static.cmake not found" }
  Copy-Item $srcTriplet (Join-Path $overlay "x64-windows-static.cmake")
  Add-Content -Path (Join-Path $overlay "x64-windows-static.cmake") -Value 'set(VCPKG_BUILD_TYPE release)'
  $env:VCPKG_OVERLAY_TRIPLETS = $overlay

  & (Join-Path $etDir "external\vcpkg\bootstrap-vcpkg.bat") -disableMetrics

  $buildDir = Join-Path $etDir "build"
  cmake -S $etDir -B $buildDir `
    -GNinja `
    -DCMAKE_BUILD_TYPE=RelWithDebInfo `
    -DDISABLE_TELEMETRY=ON `
    -DVCPKG_TARGET_TRIPLET=x64-windows-static
  if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }

  cmake --build $buildDir --target et
  if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }

  $bundleDir = Join-Path $work "win32-x64-bundle"
  New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
  $srcExe = Join-Path $buildDir "et.exe"
  if (-not (Test-Path $srcExe)) { $srcExe = Join-Path $buildDir "RelWithDebInfo\et.exe" }
  Copy-Item $srcExe (Join-Path $bundleDir "et.exe")

  # Report any non-system DLL imports (informational; a static build should
  # only import the in-box Windows DLLs).
  Write-Host "--- et.exe built ---"
  Get-Item (Join-Path $bundleDir "et.exe") | Format-List Name, Length

  $tgz = Join-Path $env:OUT_DIR "et-win32-x64.tar.gz"
  # Windows ships bsdtar as tar.exe.
  tar -czf $tgz -C $bundleDir "et.exe"
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }

  $hash = (Get-FileHash -Algorithm SHA256 $tgz).Hash.ToLower()
  $sumLine = "$hash  et-win32-x64.tar.gz"
  Set-Content -Path (Join-Path $env:OUT_DIR "et-win32-x64.tar.gz.sha256") -Value $sumLine -NoNewline
  Write-Host $sumLine
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
