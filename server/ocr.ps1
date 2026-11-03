param(
  [string]$PdfPath = '',
  [string]$OutJson = '',
  [string]$Pages = '',
  [int]$Width = 2000,
  [string]$Languages = 'zh-Hans-CN,en-US',
  [switch]$ColumnPass,
  [switch]$ListLanguages
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  try {
    $netTask.Wait(-1) | Out-Null
  } catch {
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    throw ("WinRT await failed: " + $ex.Message)
  }
  $netTask.Result
}

function AwaitAction($WinRtAction) {
  $netTask = $asTaskAction.Invoke($null, @($WinRtAction))
  $netTask.Wait(-1) | Out-Null
}

function Write-JsonFile($Path, $Object) {
  $json = $Object | ConvertTo-Json -Depth 12 -Compress
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

if ($ListLanguages) {
  $tags = @()
  foreach ($lang in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
    $tags += $lang.LanguageTag
  }
  $target = if ($OutJson) { $OutJson } else { Join-Path $env:TEMP ('ocr-languages-' + $PID + '.json') }
  Write-JsonFile $target ([ordered]@{ ok = $true; languages = @($tags) })
  Write-Output $target
  exit 0
}

if (-not $PdfPath -or -not $OutJson -or -not $Pages) {
  throw 'PdfPath, OutJson and Pages are required'
}

$pageNumbers = @()
foreach ($part in $Pages.Split(',')) {
  $trimmed = $part.Trim()
  if ($trimmed -match '^\d+$') {
    $n = [int]$trimmed
    if ($n -ge 1) { $pageNumbers += $n }
  }
}
if (-not $pageNumbers.Count) { throw 'no page numbers' }

$languageList = @()
foreach ($part in $Languages.Split(',')) {
  $tag = $part.Trim()
  if ($tag) { $languageList += $tag }
}

$engines = @{}
foreach ($tag in $languageList) {
  $lang = New-Object Windows.Globalization.Language $tag
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  if ($null -eq $engine) {
    throw "OCR language is not available: $tag"
  }
  $engines[$tag] = $engine
}

$pdfFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile])
$pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($pdfFile)) ([Windows.Data.Pdf.PdfDocument])

$workDir = Split-Path -Parent $OutJson
$resultPages = @()

foreach ($pageNumber in $pageNumbers) {
  $entry = [ordered]@{
    page = $pageNumber
    width = $null
    height = $null
    passes = [ordered]@{}
    error = $null
  }
  $pngPath = Join-Path $workDir ("page-" + $pageNumber + ".png")
  $outStream = $null
  $readStream = $null
  $bitmap = $null
  try {
    if ($pageNumber -gt $pdf.PageCount) { throw "page out of range: $pageNumber" }
    New-Item -ItemType File -Path $pngPath -Force | Out-Null
    $page = $pdf.GetPage([uint32]($pageNumber - 1))
    $pngFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pngPath)) ([Windows.Storage.StorageFile])
    $outStream = Await ($pngFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
    $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $options.DestinationWidth = [uint32]$Width
    AwaitAction ($page.RenderToStreamAsync($outStream, $options))
    $outStream.Dispose()
    $outStream = $null

    $readFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pngPath)) ([Windows.Storage.StorageFile])
    $readStream = Await ($readFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($readStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $entry.width = $bitmap.PixelWidth
    $entry.height = $bitmap.PixelHeight

    foreach ($tag in $languageList) {
      $engine = $engines[$tag]
      $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $lines = @()
      foreach ($line in $ocr.Lines) {
        $words = @()
        $minX = $null; $minY = $null; $maxX = $null; $maxY = $null
        foreach ($word in $line.Words) {
          $rect = $word.BoundingRect
          $x = [math]::Round($rect.X, 1)
          $y = [math]::Round($rect.Y, 1)
          $w = [math]::Round($rect.Width, 1)
          $h = [math]::Round($rect.Height, 1)
          $words += [ordered]@{ text = $word.Text; x = $x; y = $y; w = $w; h = $h }
          if ($null -eq $minX -or $x -lt $minX) { $minX = $x }
          if ($null -eq $minY -or $y -lt $minY) { $minY = $y }
          if ($null -eq $maxX -or ($x + $w) -gt $maxX) { $maxX = $x + $w }
          if ($null -eq $maxY -or ($y + $h) -gt $maxY) { $maxY = $y + $h }
        }
        if (-not $line.Text) { continue }
        $lines += [ordered]@{
          text = $line.Text
          x = if ($null -eq $minX) { 0 } else { $minX }
          y = if ($null -eq $minY) { 0 } else { $minY }
          w = if ($null -eq $minX) { 0 } else { [math]::Round($maxX - $minX, 1) }
          h = if ($null -eq $minY) { 0 } else { [math]::Round($maxY - $minY, 1) }
          words = $words
        }
      }
      $entry.passes[$tag] = [ordered]@{ lines = @($lines) }
    }

    if ($ColumnPass -and $engines.ContainsKey('en-US')) {
      $cropX = [uint32][math]::Floor($bitmap.PixelWidth * 0.66)
      $cropW = [uint32]($bitmap.PixelWidth - $cropX)
      $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
      $bounds = New-Object Windows.Graphics.Imaging.BitmapBounds
      $bounds.X = $cropX
      $bounds.Y = 0
      $bounds.Width = $cropW
      $bounds.Height = [uint32]$bitmap.PixelHeight
      $transform.Bounds = $bounds
      $cropped = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
      )) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $ocr = Await ($engines['en-US'].RecognizeAsync($cropped)) ([Windows.Media.Ocr.OcrResult])
      $lines = @()
      foreach ($line in $ocr.Lines) {
        $words = @()
        $minX = $null; $minY = $null; $maxX = $null; $maxY = $null
        foreach ($word in $line.Words) {
          $rect = $word.BoundingRect
          $x = [math]::Round($rect.X + $cropX, 1)
          $y = [math]::Round($rect.Y, 1)
          $w = [math]::Round($rect.Width, 1)
          $h = [math]::Round($rect.Height, 1)
          $words += [ordered]@{ text = $word.Text; x = $x; y = $y; w = $w; h = $h }
          if ($null -eq $minX -or $x -lt $minX) { $minX = $x }
          if ($null -eq $minY -or $y -lt $minY) { $minY = $y }
          if ($null -eq $maxX -or ($x + $w) -gt $maxX) { $maxX = $x + $w }
          if ($null -eq $maxY -or ($y + $h) -gt $maxY) { $maxY = $y + $h }
        }
        if (-not $line.Text) { continue }
        $lines += [ordered]@{
          text = $line.Text
          x = if ($null -eq $minX) { $cropX } else { $minX }
          y = if ($null -eq $minY) { 0 } else { $minY }
          w = if ($null -eq $minX) { 0 } else { [math]::Round($maxX - $minX, 1) }
          h = if ($null -eq $minY) { 0 } else { [math]::Round($maxY - $minY, 1) }
          words = $words
        }
      }
      $entry.passes['numbers'] = [ordered]@{ lines = @($lines); cropX = $cropX }
      try { $cropped.Dispose() } catch {}
    }
  } catch {
    $entry.error = $_.Exception.Message
  } finally {
    if ($readStream) { try { $readStream.Dispose() } catch {} }
    if ($bitmap) { try { $bitmap.Dispose() } catch {} }
    if ($outStream) { try { $outStream.Dispose() } catch {} }
    if (Test-Path $pngPath) { try { Remove-Item -LiteralPath $pngPath -Force } catch {} }
  }
  $resultPages += $entry
}

Write-JsonFile $OutJson ([ordered]@{
  ok = $true
  engine = 'windows-ocr'
  width = $Width
  languages = @($languageList)
  pdfPageCount = $pdf.PageCount
  pages = @($resultPages)
})

Write-Output $OutJson
