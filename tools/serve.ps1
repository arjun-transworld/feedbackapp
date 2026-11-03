# Minimal static server for previewing www/ on Windows without Node or Python.
# Usage: powershell -ExecutionPolicy Bypass -File tools\serve.ps1   then open http://localhost:8080
param([string]$Root = (Join-Path $PSScriptRoot "..\www"), [int]$Port = 8080)
$Root = (Resolve-Path $Root).Path
$types = @{ ".html"="text/html; charset=utf-8"; ".js"="text/javascript"; ".css"="text/css"; ".json"="application/json"; ".png"="image/png"; ".svg"="image/svg+xml" }
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $Root at http://localhost:$Port/  (Ctrl+C to stop)"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
  if (-not $path) { $path = "index.html" }
  $file = [IO.Path]::GetFullPath((Join-Path $Root $path))
  if ($file.StartsWith($Root) -and (Test-Path $file -PathType Leaf)) {
    $bytes = [IO.File]::ReadAllBytes($file)
    $type = $types[[IO.Path]::GetExtension($file)]
    if ($type) { $ctx.Response.ContentType = $type }
    $ctx.Response.Headers.Add("Cache-Control", "no-store")
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $ctx.Response.StatusCode = 404
  }
  $ctx.Response.Close()
}
