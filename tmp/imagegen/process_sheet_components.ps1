param(
  [Parameter(Mandatory = $true)][string]$AlphaPath,
  [Parameter(Mandatory = $true)][string]$NamesPath,
  [Parameter(Mandatory = $true)][string]$Slug,
  [string]$OutputRoot = "tmp\imagegen"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$names = @(Get-Content -Encoding utf8 $NamesPath | Where-Object { $_.Trim() })
if ($names.Count -lt 1 -or $names.Count -gt 25) {
  throw "Names file must contain 1..25 non-empty filenames; found $($names.Count)"
}

$root = (Resolve-Path $OutputRoot).Path
$normalizedPath = Join-Path $root "$Slug-components-sheet-1020.png"
$cellsDir = Join-Path $root "$Slug-components-cells"
$previewPath = Join-Path $root "$Slug-components-preview.png"
New-Item -ItemType Directory -Force $cellsDir | Out-Null

$alpha = [System.Drawing.Bitmap]::FromFile((Resolve-Path $AlphaPath))
try {
  $normalized = New-Object System.Drawing.Bitmap 1020, 1020, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $normalized.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($normalized)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
      $graphics.DrawImage(
        $alpha,
        (New-Object System.Drawing.Rectangle 0, 0, 1020, 1020),
        0, 0, $alpha.Width, $alpha.Height,
        [System.Drawing.GraphicsUnit]::Pixel
      )
    } finally {
      $graphics.Dispose()
    }
    $normalized.Save($normalizedPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $normalized.Dispose()
  }
} finally {
  $alpha.Dispose()
}

if (-not ("SpriteSheetTools.SpriteSheetExtractor" -as [type])) {
  Add-Type -Path (Join-Path $PSScriptRoot "SpriteSheetExtractor.cs") -ReferencedAssemblies System.Drawing
}

$report = [SpriteSheetTools.SpriteSheetExtractor]::Extract(
  $normalizedPath,
  [string[]]$names,
  $cellsDir,
  $previewPath
)

[PSCustomObject]@{
  Slug = $Slug
  Count = $report.Count
  Components = $report.Components
  DroppedComponents = $report.DroppedComponents
  BlankCellComponents = $report.BlankCellComponents
  Warnings = $report.Warnings
  CellsDir = $report.CellsDir
  Preview = $report.PreviewPath
}
