const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Word file path - check multiple locations
const wordPaths = [
  'Disbursement-DataSheet.docx',
  './Disbursement-DataSheet.docx',
  path.join(__dirname, 'Disbursement-DataSheet.docx'),
  path.join(process.cwd(), 'Disbursement-DataSheet.docx')
];

let wordFile = null;
for (const p of wordPaths) {
  if (fs.existsSync(p)) {
    wordFile = p;
    break;
  }
}

if (!wordFile) {
  console.error('❌ Word file not found');
  console.log('Searched paths:', wordPaths);
  process.exit(1);
}

console.log(`✓ Found Word file: ${wordFile}`);
console.log(`  Size: ${(fs.statSync(wordFile).size / 1024).toFixed(2)} KB`);

// Extract using PowerShell (Windows only)
try {
  const psScript = `
$docFile = '${wordFile}'
$tempDir = [System.IO.Path]::GetTempPath() + 'word_extract_' + [System.Guid]::NewGuid().ToString()
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

# Copy and extract ZIP
Copy-Item $docFile "$tempDir\\document.zip"
Expand-Archive "$tempDir\\document.zip" -DestinationPath "$tempDir" -Force

# Read document.xml
$docXml = Get-Content "$tempDir\\word\\document.xml" -Raw
Write-Host $docXml
`;

  const output = execSync(`powershell -Command "${psScript.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  console.log('Document content extracted');
  console.log('Length:', output.length);
  
  // Save for analysis
  fs.writeFileSync('./word_extract.xml', output);
  console.log('✓ Saved XML to word_extract.xml');
  
} catch (err) {
  console.error('❌ Extraction failed:', err.message);
  process.exit(1);
}
