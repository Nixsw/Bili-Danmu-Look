param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y,
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Height,
    [int]$Threshold = 100
)

# 只读取原始截图，分析指定单行文字区域；不修改或重新保存图像。
# 连续相同汉字用于测量重复字形起点间距。字形墨迹高度不等于字体字号。
Add-Type -AssemblyName System.Drawing
$fontMeasureBitmap = [System.Drawing.Bitmap]::new((Resolve-Path -LiteralPath $ImagePath).Path)
try {
    if ($X -lt 0 -or $Y -lt 0 -or $Width -le 0 -or $Height -le 0 -or
        ($X + $Width) -gt $fontMeasureBitmap.Width -or ($Y + $Height) -gt $fontMeasureBitmap.Height) {
        throw '测量区域超出原图边界。'
    }

    $fontMeasureColumns = [int[]]::new($Width)
    $fontMeasureRows = [int[]]::new($Height)
    for ($dy = 0; $dy -lt $Height; $dy++) {
        for ($dx = 0; $dx -lt $Width; $dx++) {
            $pixel = $fontMeasureBitmap.GetPixel($X + $dx, $Y + $dy)
            $channelMin = [Math]::Min($pixel.R, [Math]::Min($pixel.G, $pixel.B))
            $channelMax = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
            if ($channelMin -ge $Threshold -and ($channelMax - $channelMin) -le 80) {
                $fontMeasureColumns[$dx]++
                $fontMeasureRows[$dy]++
            }
        }
    }

    $fontMeasureRuns = [System.Collections.Generic.List[object]]::new()
    $fontMeasureRunStart = -1
    for ($dx = 0; $dx -le $Width; $dx++) {
        $occupied = $dx -lt $Width -and $fontMeasureColumns[$dx] -gt 0
        if ($occupied -and $fontMeasureRunStart -lt 0) { $fontMeasureRunStart = $dx }
        if (-not $occupied -and $fontMeasureRunStart -ge 0) {
            $fontMeasureRuns.Add([pscustomobject]@{
                left = $X + $fontMeasureRunStart
                right = $X + $dx - 1
                width = $dx - $fontMeasureRunStart
            })
            $fontMeasureRunStart = -1
        }
    }

    $fontMeasurePitches = @(
        for ($i = 1; $i -lt $fontMeasureRuns.Count; $i++) {
            $fontMeasureRuns[$i].left - $fontMeasureRuns[$i - 1].left
        }
    )
    $fontMeasureActiveRows = @(for ($dy = 0; $dy -lt $Height; $dy++) {
        if ($fontMeasureRows[$dy] -gt 0) { $Y + $dy }
    })
    $fontMeasureInkHeight = if ($fontMeasureActiveRows.Count -gt 0) {
        $fontMeasureActiveRows[-1] - $fontMeasureActiveRows[0] + 1
    } else { 0 }

    [pscustomobject]@{
        image = (Split-Path -Leaf $ImagePath)
        imageSize = @($fontMeasureBitmap.Width, $fontMeasureBitmap.Height)
        region = @($X, $Y, $Width, $Height)
        threshold = $Threshold
        inkTop = if ($fontMeasureActiveRows.Count) { $fontMeasureActiveRows[0] } else { $null }
        inkBottom = if ($fontMeasureActiveRows.Count) { $fontMeasureActiveRows[-1] } else { $null }
        inkHeight = $fontMeasureInkHeight
        columnRuns = @($fontMeasureRuns.ToArray())
        runStartDistances = $fontMeasurePitches
        note = '截图像素测量；应检查分段是否逐字对应，不能直接把墨迹高度当成字号。'
    } | ConvertTo-Json -Depth 5
}
finally {
    $fontMeasureBitmap.Dispose()
}
