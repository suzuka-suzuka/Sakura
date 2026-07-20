param(
  [Parameter(Mandatory = $true)][string]$CellsDir,
  [Parameter(Mandatory = $true)][string]$NamesPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$directory = (Resolve-Path $CellsDir).Path
$names = @(Get-Content -Encoding utf8 $NamesPath | Where-Object { $_.Trim() })
$issues = New-Object System.Collections.Generic.List[string]
$maximumOffset = 0.0

foreach ($name in $names) {
  $path = Join-Path $directory $name
  if (-not (Test-Path -LiteralPath $path)) {
    $issues.Add("missing:$name")
    continue
  }

  $bitmap = [System.Drawing.Bitmap]::FromFile($path)
  try {
    if ($bitmap.Width -ne 204 -or $bitmap.Height -ne 204) {
      $issues.Add("size:$name=$($bitmap.Width)x$($bitmap.Height)")
      continue
    }

    $minX = 204
    $minY = 204
    $maxX = -1
    $maxY = -1
    $edge = 0
    $green = 0
    for ($y = 0; $y -lt 204; $y++) {
      for ($x = 0; $x -lt 204; $x++) {
        $color = $bitmap.GetPixel($x, $y)
        if ($color.A -le 0) { continue }
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
        if ($x -eq 0 -or $x -eq 203 -or $y -eq 0 -or $y -eq 203) { $edge++ }
        if ($color.G -gt 120 -and $color.G -gt ($color.R * 1.35) -and $color.G -gt ($color.B * 1.35)) { $green++ }
      }
    }

    if ($maxX -lt 0) {
      $issues.Add("empty:$name")
      continue
    }
    if ($edge -gt 0) { $issues.Add("edge:$name=$edge") }
    if ($green -gt 0) { $issues.Add("green:$name=$green") }
    $offsetX = [Math]::Abs((($minX + $maxX) / 2.0) - 101.5)
    $offsetY = [Math]::Abs((($minY + $maxY) / 2.0) - 101.5)
    $maximumOffset = [Math]::Max($maximumOffset, [Math]::Max($offsetX, $offsetY))
    if ($offsetX -gt 0.5 -or $offsetY -gt 0.5) {
      $issues.Add("off-center:$name=$offsetX,$offsetY")
    }
  } finally {
    $bitmap.Dispose()
  }
}

[PSCustomObject]@{
  Validated = $names.Count
  Issues = $issues.Count
  MaximumCenterOffset = $maximumOffset
  Details = ($issues -join "; ")
}
