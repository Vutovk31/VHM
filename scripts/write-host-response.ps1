param(
  [Parameter(Mandatory)][string]$HostDirectory,
  [Parameter(Mandatory)][Guid]$RequestId,
  [Parameter(Mandatory)][string]$Chunk,
  [switch]$First,
  [switch]$Last
)
$ErrorActionPreference = 'Stop'
$directory = (Resolve-Path -LiteralPath $HostDirectory).Path
$id = $RequestId.ToString()
$request = Join-Path $directory "$id.request.json"
$staged = Join-Path $directory "$id.response.staged"
$response = Join-Path $directory "$id.response.json"
if (!(Test-Path -LiteralPath $request -PathType Leaf) -or (Test-Path -LiteralPath $response)) {
  throw 'Pending host request required'
}
if ($First) {
  $stream = [IO.File]::Open($staged, [IO.FileMode]::CreateNew)
  $stream.Dispose()
}
if (!(Test-Path -LiteralPath $staged -PathType Leaf)) { throw 'Missing staged response' }
[IO.File]::AppendAllText($staged, $Chunk)
if ($Last) {
  $payload = [IO.File]::ReadAllText($staged) | ConvertFrom-Json
  if ($payload.id -cne $id -or
      ($null -eq $payload.result -and $payload.transportError -ne $true)) {
    throw 'Invalid host response envelope'
  }
  [IO.File]::Move($staged, $response)
}
