# Refresh TOC with local Word, then export PDF.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM.
# Order matters: update fields/toc FIRST, then apply direct paragraph formatting,
# otherwise the rebuild discards it.
param(
  [string]$Docx = "E:\some_brain_think\first\Personal_Workbench\submission\ppt\huanyihuan.docx",
  [string]$Pdf  = "E:\some_brain_think\first\Personal_Workbench\submission\ppt\huanyihuan.pdf"
)

$ErrorActionPreference = "Stop"
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
  $d = $word.Documents.Open($Docx, $false, $false)

  $d.Fields.Update() | Out-Null
  if ($d.TablesOfContents.Count -gt 0) {
    $toc = $d.TablesOfContents.Item(1)
    $toc.Update()
    $rng = $toc.Range
    $rng.ParagraphFormat.SpaceBefore = 0
    $rng.ParagraphFormat.SpaceAfter = 2
    $rng.ParagraphFormat.LineSpacingRule = 4
    $rng.ParagraphFormat.LineSpacing = 13.5
    $rng.ParagraphFormat.Alignment = 0
  }
  $d.Repaginate()

  $pages = $d.ComputeStatistics(2)
  Write-Output ("pages=" + $pages)

  $d.Save()
  $d.SaveAs([ref]$Pdf, [ref]17)
  $d.Close($false)
}
finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  [GC]::Collect()
}
Write-Output ("pdf=" + $Pdf)
