# Builds a Firefox-ready copy of the extension in dist\firefox
# and zips it to dist\jsyringe-firefox.zip (installable via about:debugging or web-ext).
$src = $PSScriptRoot
$out = Join-Path $src "dist\firefox"
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $out | Out-Null

$files = @("background.js","popup.html","popup.css","popup.js","dashboard.html","dashboard.css","dashboard.js","theme.css","README.md")
foreach ($f in $files) { Copy-Item (Join-Path $src $f) $out }
Copy-Item (Join-Path $src "icons") $out -Recurse
Copy-Item (Join-Path $src "lib") $out -Recurse
Copy-Item (Join-Path $src "manifest.firefox.json") (Join-Path $out "manifest.json")

$zip = Join-Path $src "dist\jsyringe-firefox.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $out "*") -DestinationPath $zip
Write-Host "Firefox build ready: $out"
Write-Host "Zip: $zip"
