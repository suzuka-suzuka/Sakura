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
$alpha = [System.Drawing.Bitmap]::FromFile((Resolve-Path $AlphaPath))
$normalizedPath = Join-Path $root "$Slug-sheet-1020.png"
$cellsDir = Join-Path $root "$Slug-cells"
$previewPath = Join-Path $root "$Slug-preview.png"
New-Item -ItemType Directory -Force $cellsDir | Out-Null

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

$sheet = [System.Drawing.Bitmap]::FromFile($normalizedPath)
$warnings = New-Object System.Collections.Generic.List[string]
try {
  for ($index = 0; $index -lt $names.Count; $index++) {
    $name = $names[$index]
    $column = $index % 5
    $row = [Math]::Floor($index / 5)
    $source = $sheet.Clone(
      (New-Object System.Drawing.Rectangle ($column * 204), ($row * 204), 204, 204),
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    try {
      $minX = $source.Width
      $minY = $source.Height
      $maxX = -1
      $maxY = -1
      $sourceEdge = 0
      for ($y = 0; $y -lt $source.Height; $y++) {
        for ($x = 0; $x -lt $source.Width; $x++) {
          $color = $source.GetPixel($x, $y)
          if ($color.A -gt 0) {
            if ($x -lt $minX) { $minX = $x }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($y -gt $maxY) { $maxY = $y }
            if ($x -eq 0 -or $x -eq 203 -or $y -eq 0 -or $y -eq 203) { $sourceEdge++ }
          }
        }
      }
      if ($maxX -lt 0) { throw "No visible pixels in cell $($index + 1): $name" }
      if ($sourceEdge -gt 0) { $warnings.Add("source-edge:$name=$sourceEdge") }

      $width = $maxX - $minX + 1
      $height = $maxY - $minY + 1
      $scale = [Math]::Min(1.0, [Math]::Min(188.0 / $width, 188.0 / $height))
      $destWidth = [Math]::Max(1, [int][Math]::Round($width * $scale))
      $destHeight = [Math]::Max(1, [int][Math]::Round($height * $scale))
      $destX = [int][Math]::Floor((204 - $destWidth) / 2)
      $destY = [int][Math]::Floor((204 - $destHeight) / 2)

      $output = New-Object System.Drawing.Bitmap 204, 204, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      try {
        $output.SetResolution(96, 96)
        $graphics = [System.Drawing.Graphics]::FromImage($output)
        try {
          $graphics.Clear([System.Drawing.Color]::Transparent)
          $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
          $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
          $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
          $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
          $graphics.DrawImage(
            $source,
            (New-Object System.Drawing.Rectangle $destX, $destY, $destWidth, $destHeight),
            $minX, $minY, $width, $height,
            [System.Drawing.GraphicsUnit]::Pixel
          )
        } finally {
          $graphics.Dispose()
        }
        $output.Save((Join-Path $cellsDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $output.Dispose()
      }
    } finally {
      $source.Dispose()
    }
  }
} finally {
  $sheet.Dispose()
}

$preview = New-Object System.Drawing.Bitmap 1020, 1020, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $preview.SetResolution(96, 96)
  $graphics = [System.Drawing.Graphics]::FromImage($preview)
  try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(255, 248, 248, 246))
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    for ($index = 0; $index -lt $names.Count; $index++) {
      $image = [System.Drawing.Bitmap]::FromFile((Join-Path $cellsDir $names[$index]))
      try {
        $graphics.DrawImageUnscaled($image, (($index % 5) * 204), ([Math]::Floor($index / 5) * 204))
      } finally {
        $image.Dispose()
      }
    }
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 218, 218, 214)), 1
    try {
      for ($index = 1; $index -lt 5; $index++) {
        $position = $index * 204
        $graphics.DrawLine($pen, $position, 0, $position, 1019)
        $graphics.DrawLine($pen, 0, $position, 1019, $position)
      }
    } finally {
      $pen.Dispose()
    }
  } finally {
    $graphics.Dispose()
  }
  $preview.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $preview.Dispose()
}

[PSCustomObject]@{
  Slug = $Slug
  Count = $names.Count
  CellsDir = $cellsDir
  Preview = $previewPath
  Warnings = $warnings.Count
  WarningDetails = ($warnings -join "; ")
}
