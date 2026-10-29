#requires -Version 5
<#
  Build the Breeze TTS 2 Windows installer.
  Requirements: csc.exe from .NET Framework 4.x (ships with Windows), WebView2 runtime (preinstalled on Win10/11).
  The WebView2 SDK is downloaded from nuget.org into deps\ on first build.
  Usage: powershell -ExecutionPolicy Bypass -File build\build.ps1 [-BreezeDir <dir>] [-OutDir <dir>]
#>
param(
  [string]$BreezeDir = "D:\breeze-tts-2",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not $OutDir) { $OutDir = Join-Path $root "out" }
$Csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$WV2_VER = "1.0.4314.35"
if (-not (Test-Path $Csc)) { throw "csc.exe not found: $Csc" }
if (-not (Test-Path (Join-Path $BreezeDir "breeze-server.exe"))) { throw "breeze-server.exe not found in $BreezeDir" }

$deps = Join-Path $root "deps"
New-Item -ItemType Directory -Force -Path $deps | Out-Null

function Ensure-WebView2 {
  $core = Join-Path $deps "Microsoft.Web.WebView2.Core.dll"
  $forms = Join-Path $deps "Microsoft.Web.WebView2.WinForms.dll"
  $loader = Join-Path $deps "WebView2Loader.dll"
  if ((Test-Path $core) -and (Test-Path $forms) -and (Test-Path $loader)) { return }
  Write-Host "  fetching WebView2 SDK $WV2_VER"
  $nupkg = Join-Path $deps "wv2.zip"
  $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$WV2_VER/microsoft.web.webview2.$WV2_VER.nupkg"
  Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg)
  try {
    foreach ($e in $zip.Entries) {
      $n = $e.FullName
      if ($n -eq "lib/net462/Microsoft.Web.WebView2.Core.dll" -or
          $n -eq "lib/net462/Microsoft.Web.WebView2.WinForms.dll" -or
          $n -eq "runtimes/win-x64/native/WebView2Loader.dll") {
        $dst = Join-Path $deps ([IO.Path]::GetFileName($n))
        if (Test-Path $dst) { Remove-Item $dst -Force }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dst, $true)
      }
    }
  } finally { $zip.Dispose() }
  Remove-Item $nupkg -Force
  if (-not ((Test-Path $core) -and (Test-Path $forms) -and (Test-Path $loader))) { throw "WebView2 SDK extraction failed" }
}

Write-Host "[0/5] WebView2 SDK $WV2_VER"
Ensure-WebView2

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$launcherOut = Join-Path $OutDir "BreezeTTS2.exe"
$stubOut = Join-Path $OutDir "setup-stub.exe"
$setupOut = Join-Path $OutDir "BreezeTTS2Setup.exe"

Get-Process BreezeTTS2Setup -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $launcherOut, $stubOut, $setupOut -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

Push-Location $root
try {
  Write-Host "[1/5] launcher"
  & $Csc -nologo -target:winexe -codepage:65001 "-out:$launcherOut" "-win32icon:assets\icon.ico" `
    "-resource:src\ui\index.html,ui.index.html" `
    "-resource:src\ui\style.css,ui.style.css" `
    "-resource:src\ui\app.js,ui.app.js" `
    -r:System.dll -r:System.Core.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll `
    -r:deps\Microsoft.Web.WebView2.Core.dll -r:deps\Microsoft.Web.WebView2.WinForms.dll `
    src\launcher\Program.cs src\launcher\Window.cs
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $launcherOut)) { throw "launcher build failed" }

  Write-Host "[2/5] setup stub"
  & $Csc -nologo -target:winexe -codepage:65001 "-out:$stubOut" "-win32icon:assets\icon.ico" `
    -r:System.dll -r:System.Core.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll `
    -r:System.IO.Compression.dll -r:System.IO.Compression.FileSystem.dll src\setup\Program.cs
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $stubOut)) { throw "setup build failed" }
}
finally { Pop-Location }

Write-Host "[3/5] payload"
$payload = Join-Path $OutDir "payload"
if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payload | Out-Null
Copy-Item $launcherOut $payload
foreach ($d in @("Microsoft.Web.WebView2.Core.dll","Microsoft.Web.WebView2.WinForms.dll","WebView2Loader.dll")) {
  Copy-Item (Join-Path $deps $d) $payload
}
foreach ($f in @("breeze-server.exe","breeze-cli.exe","breeze-convert.exe","breeze-quantize.exe","libbreeze.dll","LICENSE","README.md","THIRD_PARTY_NOTICES.txt")) {
  $p = Join-Path $BreezeDir $f
  if (Test-Path $p) { Copy-Item $p $payload }
}
Get-ChildItem -Path $BreezeDir -Filter *.txt -File | Copy-Item -Destination $payload -Force
$docs = Join-Path $BreezeDir "docs"
if (Test-Path $docs) { Copy-Item $docs (Join-Path $payload "docs") -Recurse }
New-Item -ItemType Directory -Force -Path (Join-Path $payload "voices") | Out-Null

$zip = Join-Path $OutDir "payload.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($payload, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Write-Host ("  raw {0:N1} MB -> packed {1:N1} MB" -f ((Get-ChildItem $payload -Recurse -File | Measure-Object Length -Sum).Sum/1MB), ((Get-Item $zip).Length/1MB))

Write-Host "[4/5] link installer"
$stub = [IO.File]::ReadAllBytes($stubOut)
$zipBytes = [IO.File]::ReadAllBytes($zip)
$fs = [IO.File]::Create($setupOut)
try {
  $fs.Write($stub, 0, $stub.Length)
  $fs.Write($zipBytes, 0, $zipBytes.Length)
  $tr = New-Object byte[] 24
  [Text.Encoding]::ASCII.GetBytes("BREEZESF").CopyTo($tr, 0)
  [BitConverter]::GetBytes([int64]$stub.Length).CopyTo($tr, 8)
  [BitConverter]::GetBytes([int64]$zipBytes.Length).CopyTo($tr, 16)
  $fs.Write($tr, 0, 24)
} finally { $fs.Close() }

Write-Host "[5/5] done"
Write-Host ("  {0}  ({1:N1} MB)" -f $setupOut, ((Get-Item $setupOut).Length/1MB))
