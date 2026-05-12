$ErrorActionPreference = "Stop"
$mdPath = "c:\Users\usuario\Desktop\bot-cob\bot-mutual-mvp\PROCESOS_BOT_ACTUAL.md"
# Si el .docx principal esta abierto en Word, guardamos como _v2 para no chocar.
$docxPath = "c:\Users\usuario\Desktop\bot-cob\bot-mutual-mvp\PROCESOS_BOT_ACTUAL.docx"
try {
    $stream = [System.IO.File]::Open($docxPath, 'Open', 'Write')
    $stream.Close()
} catch {
    $docxPath = "c:\Users\usuario\Desktop\bot-cob\bot-mutual-mvp\PROCESOS_BOT_ACTUAL_v2.docx"
    Write-Output "(archivo principal en uso, guardando como _v2)"
}

# Constantes wdStyle (independientes del idioma de Office)
$wdStyleNormal     = -1
$wdStyleHeading1   = -2
$wdStyleHeading2   = -3
$wdStyleHeading3   = -4
$wdStyleHeading4   = -5
$wdStyleListBullet = -73
$wdStyleListNumber = -76

$rawLines = Get-Content -Path $mdPath -Encoding UTF8

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$doc = $word.Documents.Add()
$sel = $word.Selection

function Set-Style {
    param([int]$styleId)
    $sel.Style = $doc.Styles.Item($styleId)
}

function Write-FormattedText {
    param([string]$text)
    $pattern = '(\*\*[^*]+\*\*|`[^`]+`)'
    $parts = [regex]::Split($text, $pattern)
    foreach ($part in $parts) {
        if ([string]::IsNullOrEmpty($part)) { continue }
        if ($part -match '^\*\*(.+)\*\*$') {
            $sel.Font.Bold = $true
            $sel.TypeText($matches[1])
            $sel.Font.Bold = $false
        } elseif ($part -match '^`(.+)`$') {
            $sel.Font.Name = "Consolas"
            $sel.TypeText($matches[1])
            $sel.Font.Name = "Calibri"
        } else {
            $sel.TypeText($part)
        }
    }
}

function Add-StyledParagraph {
    param([string]$text, [int]$styleId)
    Set-Style -styleId $styleId
    Write-FormattedText -text $text
    $sel.TypeParagraph()
}

function Add-Table {
    param([array]$rows)
    if ($rows.Count -eq 0) { return }
    $cols = ($rows[0] -split '\|').Where({ $_ -ne '' }).Count
    $rowCount = $rows.Count
    Set-Style -styleId $wdStyleNormal
    $range = $sel.Range
    $table = $doc.Tables.Add($range, $rowCount, $cols)
    $table.Borders.Enable = $true
    for ($r = 0; $r -lt $rowCount; $r++) {
        $cells = ($rows[$r] -split '\|').Where({ $_ -ne '' })
        for ($c = 0; $c -lt $cols; $c++) {
            $cellText = if ($c -lt $cells.Count) { $cells[$c].Trim() } else { "" }
            $cellText = $cellText -replace '\*\*', ''
            $cellText = $cellText -replace '`', ''
            $cell = $table.Cell($r + 1, $c + 1).Range
            $cell.Text = $cellText
            if ($r -eq 0) { $cell.Font.Bold = $true }
        }
    }
    $sel.EndKey(6, 0) | Out-Null
    $sel.TypeParagraph()
}

function Add-CodeBlock {
    param([array]$lines)
    Set-Style -styleId $wdStyleNormal
    foreach ($l in $lines) {
        $sel.Font.Name = "Consolas"
        $sel.Font.Size = 9
        $sel.TypeText($l)
        $sel.TypeParagraph()
    }
    $sel.Font.Name = "Calibri"
    $sel.Font.Size = 11
}

$i = 0
$inTable = $false
$tableRows = @()
$inCode = $false
$codeLines = @()

while ($i -lt $rawLines.Count) {
    $line = $rawLines[$i]

    if ($line -match '^```') {
        if ($inCode) {
            Add-CodeBlock -lines $codeLines
            $codeLines = @()
            $inCode = $false
        } else {
            $inCode = $true
        }
        $i++; continue
    }
    if ($inCode) {
        $codeLines += $line
        $i++; continue
    }

    if ($line -match '^\|') {
        if ($line -match '^\|[\s\-:|]+\|\s*$') { $i++; continue }
        $tableRows += $line
        $inTable = $true
        $i++; continue
    } elseif ($inTable) {
        Add-Table -rows $tableRows
        $tableRows = @()
        $inTable = $false
    }

    if ($line -match '^#\s+(.+)$') { Add-StyledParagraph -text $matches[1] -styleId $wdStyleHeading1; $i++; continue }
    if ($line -match '^##\s+(.+)$') { Add-StyledParagraph -text $matches[1] -styleId $wdStyleHeading2; $i++; continue }
    if ($line -match '^###\s+(.+)$') { Add-StyledParagraph -text $matches[1] -styleId $wdStyleHeading3; $i++; continue }
    if ($line -match '^####\s+(.+)$') { Add-StyledParagraph -text $matches[1] -styleId $wdStyleHeading4; $i++; continue }

    if ($line -match '^---\s*$') {
        Set-Style -styleId $wdStyleNormal
        $sel.TypeParagraph()
        $i++; continue
    }

    if ($line -match '^>\s*(.*)$') {
        Set-Style -styleId $wdStyleNormal
        $sel.Font.Italic = $true
        $sel.TypeText("    " + $matches[1])
        $sel.Font.Italic = $false
        $sel.TypeParagraph()
        $i++; continue
    }

    if ($line -match '^\d+\.\s+(.+)$') { Add-StyledParagraph -text $matches[1] -styleId $wdStyleListNumber; $i++; continue }

    if ($line -match '^\s*-\s+(.+)$') { Add-StyledParagraph -text $matches[1] -styleId $wdStyleListBullet; $i++; continue }

    if ([string]::IsNullOrWhiteSpace($line)) { $i++; continue }

    if ($line -match '^\*(.+)\*$') {
        Set-Style -styleId $wdStyleNormal
        $sel.Font.Italic = $true
        $sel.TypeText($matches[1])
        $sel.Font.Italic = $false
        $sel.TypeParagraph()
        $i++; continue
    }

    Set-Style -styleId $wdStyleNormal
    Write-FormattedText -text $line
    $sel.TypeParagraph()
    $i++
}

if ($inTable -and $tableRows.Count -gt 0) {
    Add-Table -rows $tableRows
}

$doc.SaveAs([ref]$docxPath, [ref]16)
$doc.Close()
$word.Quit()

[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sel) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
[GC]::Collect() | Out-Null
[GC]::WaitForPendingFinalizers() | Out-Null

Write-Output "OK: $docxPath"
