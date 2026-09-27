param(
    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$Owner = 'Kiro-Durandal',

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'MihomoForUFI',

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^v[A-Za-z0-9._-]+$')]
    [string]$Tag = 'v2.6-rc2'
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$rootName = 'F50-Mihomo-UFI-Device-Manager-Beta2.6-RC2'
$assetName = "$rootName-arm64.tar"
$dist = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'dist'))
$work = [IO.Path]::GetFullPath((Join-Path $sourceRoot '.release-work'))
$payload = Join-Path $work $rootName
$manifestUrl = "https://raw.githubusercontent.com/$Owner/$Repository/$Tag/release-manifest.json"
$gitMetadataPrefix = [IO.Path]::GetFullPath((Join-Path $sourceRoot '.git')) + [IO.Path]::DirectorySeparatorChar

if ($Tag -ne 'v2.6-rc2') {
    throw 'This RC2 source only accepts the immutable tag v2.6-rc2.'
}
if ($Owner -cne 'Kiro-Durandal' -or $Repository -cne 'MihomoForUFI') {
    throw 'This RC2 source is pinned to Kiro-Durandal/MihomoForUFI.'
}

foreach ($target in @($dist, $work)) {
    if (-not $target.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe build path: $target"
    }
}

$runtimePath = Join-Path $sourceRoot 'runtime\mihomo'
$runtimeLicensePath = Join-Path $sourceRoot 'runtime\LICENSE.mihomo'
$runtimeProvenancePath = Join-Path $sourceRoot 'runtime\MIHOMO-PROVENANCE.md'
$runtimeSourceArchivePath = Join-Path $sourceRoot 'runtime\mihomo-v1.19.31-source.tar.gz'
$runtimeSourceAssetName = 'mihomo-v1.19.31-source.tar.gz'
$expectedRuntimeBytes = 63866712
$expectedRuntimeSha256 = 'dbd8af275219a097d66362d543b32f65ba0d4de9d96a49bf5e9abdcdad3af6f1'
$expectedLicenseSha256 = '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986'
$expectedRuntimeSourceBytes = 1263209
$expectedRuntimeSourceSha256 = '5a04aa9cf4520e06fa1c13d37b6aca49209479690722d485c40034ab17f8581f'

if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
    throw 'runtime/mihomo is missing. Inject a verified arm64 binary before building.'
}
if ((Get-Item -LiteralPath $runtimePath).Length -ne $expectedRuntimeBytes) {
    throw 'runtime/mihomo byte size does not match the pinned v1.19.31 binary.'
}
if ((Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedRuntimeSha256) {
    throw 'runtime/mihomo SHA-256 does not match the pinned v1.19.31 binary.'
}
$runtimeHeader = [byte[]]::new(20)
$runtimeStream = [IO.File]::OpenRead($runtimePath)
try {
    if ($runtimeStream.Read($runtimeHeader, 0, $runtimeHeader.Length) -ne $runtimeHeader.Length) {
        throw 'runtime/mihomo is too short to contain a valid ELF header.'
    }
} finally {
    $runtimeStream.Dispose()
}
$runtimeMachine = [BitConverter]::ToUInt16($runtimeHeader, 18)
if ($runtimeHeader[0] -ne 0x7f -or $runtimeHeader[1] -ne 0x45 -or
    $runtimeHeader[2] -ne 0x4c -or $runtimeHeader[3] -ne 0x46 -or
    $runtimeHeader[4] -ne 2 -or $runtimeHeader[5] -ne 1 -or $runtimeMachine -ne 183) {
    throw 'runtime/mihomo is not a little-endian ELF64 AArch64 executable.'
}
if (-not (Test-Path -LiteralPath $runtimeLicensePath -PathType Leaf) -or
    (Get-FileHash -LiteralPath $runtimeLicensePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedLicenseSha256) {
    throw 'runtime/LICENSE.mihomo is missing or differs from the pinned upstream GPL-3.0 license.'
}
if (-not (Test-Path -LiteralPath $runtimeProvenancePath -PathType Leaf)) {
    throw 'runtime/MIHOMO-PROVENANCE.md is missing.'
}
if (-not (Test-Path -LiteralPath $runtimeSourceArchivePath -PathType Leaf)) {
    throw 'The pinned Mihomo corresponding-source archive is missing.'
}
if ((Get-Item -LiteralPath $runtimeSourceArchivePath).Length -ne $expectedRuntimeSourceBytes) {
    throw 'The Mihomo corresponding-source archive byte size does not match v1.19.31.'
}
if ((Get-FileHash -LiteralPath $runtimeSourceArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedRuntimeSourceSha256) {
    throw 'The Mihomo corresponding-source archive SHA-256 does not match v1.19.31.'
}
$runtimeSourceEntries = @(& tar -tzf $runtimeSourceArchivePath)
if ($LASTEXITCODE -ne 0) {
    throw 'The Mihomo corresponding-source archive cannot be listed by tar.'
}
foreach ($requiredEntry in @(
    'mihomo-1.19.31/LICENSE',
    'mihomo-1.19.31/go.mod',
    'mihomo-1.19.31/main.go'
)) {
    if ($runtimeSourceEntries -cnotcontains $requiredEntry) {
        throw "The Mihomo corresponding-source archive is missing $requiredEntry."
    }
}

$template = Join-Path $sourceRoot 'config\config.template.yaml'
$templateText = Get-Content -LiteralPath $template -Raw
if ($templateText.Contains('__REVIEW_REQUIRED__')) {
    throw 'config.template.yaml is still marked __REVIEW_REQUIRED__.'
}
$unresolved = [regex]::Matches($templateText, '__[A-Z0-9_]+__') |
    ForEach-Object Value |
    Where-Object { $_ -ne '__SUBSCRIPTION_URL__' } |
    Sort-Object -Unique
if ($unresolved) {
    throw "Unresolved configuration placeholders: $($unresolved -join ', ')"
}
$subscriptionPlaceholders = [regex]::Matches($templateText, '(?m)^    url: __SUBSCRIPTION_URL__\r?$')
if ($subscriptionPlaceholders.Count -ne 1) {
    throw 'config.template.yaml must contain exactly one main subscription placeholder.'
}
$controllerDefaults = [regex]::Matches($templateText, '(?m)^external-controller: 0\.0\.0\.0:9090\r?$')
if ($controllerDefaults.Count -ne 1) {
    throw 'config.template.yaml must expose the reviewed controller endpoint 0.0.0.0:9090.'
}
$controllerSecrets = [regex]::Matches($templateText, "(?m)^secret: '123456'\r?$")
$allControllerSecrets = [regex]::Matches($templateText, '(?m)^secret\s*:.*\r?$')
if ($controllerSecrets.Count -ne 1 -or $allControllerSecrets.Count -ne 1) {
    throw 'config.template.yaml must contain the requested initial controller secret.'
}
if ($templateText -match '(?m)^proxies\s*:\s*\r?$') {
    throw 'config.template.yaml must not contain inline proxy nodes.'
}
if ($templateText -match '(?mi)^\s+(?:server|server-port|uuid|password|private-key|client-id|client-secret|short-id|psk|token)\s*:') {
    throw 'config.template.yaml contains a node address or credential field.'
}

$jsPath = Join-Path $sourceRoot 'f50-mihomo-ufi-device-manager-beta2.6-rc2.js'
$jsText = Get-Content -LiteralPath $jsPath -Raw
if ($jsText.Contains('__GITHUB_RAW_RELEASE_MANIFEST_URL__')) {
    $jsText = $jsText.Replace('__GITHUB_RAW_RELEASE_MANIFEST_URL__', $manifestUrl)
} elseif (-not $jsText.Contains($manifestUrl)) {
    throw 'The JS manifest URL is already set to a different repository or tag.'
}

$scanFiles = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File |
    Where-Object {
        $_.FullName -notlike "$dist*" -and
        $_.FullName -notlike "$work*" -and
        -not $_.FullName.StartsWith($gitMetadataPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        $_.Name -ne 'mihomo'
    }
$forbidden = @(
    '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    '(?i)\b(?:ss|ssr|vmess|vless|trojan|hysteria2?|tuic|wireguard)://',
    '(?i)(?:token|password|passwd|private-key)\s*:\s*["''][^_<{][^"'']+["'']',
    '(?i)https?://[^\s"'']+[?&](?:token|key|auth|password)=[^\s&"'']+',
    '(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b'
)
foreach ($file in $scanFiles) {
    if ($file.Extension -notin @('.sh', '.js', '.md', '.yaml', '.yml', '.json', '.txt', '.ps1', '')) { continue }
    $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    foreach ($pattern in $forbidden) {
        if ($text -match $pattern) {
            throw "Potential credential pattern in $($file.FullName). Review it manually."
        }
    }
}

[IO.File]::WriteAllText($jsPath, $jsText, [Text.UTF8Encoding]::new($false))

if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
New-Item -ItemType Directory -Path $payload -Force | Out-Null
New-Item -ItemType Directory -Path $dist -Force | Out-Null

$payloadItems = @(
    'AUDIT.md',
    'CHANGELOG.md',
    'CONFIG-REVIEW.md',
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
    'install.sh',
    'install-upgrade.sh',
    'rollback-last.sh',
    'ufi-backend.sh',
    'f50-mihomo-ufi-device-manager-beta2.6-rc2.js',
    'config',
    'runtime',
    'scripts'
)
foreach ($item in $payloadItems) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $item) -Destination $payload -Recurse
}
$payloadSourceArchivePath = Join-Path $payload 'runtime\mihomo-v1.19.31-source.tar.gz'
if (Test-Path -LiteralPath $payloadSourceArchivePath -PathType Leaf) {
    Remove-Item -LiteralPath $payloadSourceArchivePath -Force
}

$hashLines = Get-ChildItem -LiteralPath $payload -Recurse -File |
    Where-Object Name -ne 'SHA256SUMS.txt' |
    Sort-Object FullName |
    ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($payload, $_.FullName).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $relative"
    }
Set-Content -LiteralPath (Join-Path $payload 'SHA256SUMS.txt') -Value $hashLines -Encoding utf8NoBOM

$asset = Join-Path $dist $assetName
Push-Location $work
try {
    & tar -cf $asset $rootName
    if ($LASTEXITCODE -ne 0) { throw 'tar failed.' }
} finally {
    Pop-Location
}

$assetInfo = Get-Item -LiteralPath $asset
$assetHash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
$assetUrl = "https://github.com/$Owner/$Repository/releases/download/$Tag/$assetName"
$runtimeSourceAssetPath = Join-Path $dist $runtimeSourceAssetName
Copy-Item -LiteralPath $runtimeSourceArchivePath -Destination $runtimeSourceAssetPath
$runtimeSourceUrl = "https://github.com/$Owner/$Repository/releases/download/$Tag/$runtimeSourceAssetName"
$manifest = [ordered]@{
    schema = 1
    version = '2.6-RC2'
    published = $true
    package = [ordered]@{
        name = $assetName
        root_dir = $rootName
        url = $assetUrl
        sha256 = $assetHash
        bytes = $assetInfo.Length
    }
    third_party_source = [ordered]@{
        component = 'MetaCubeX/mihomo'
        version = 'v1.19.31'
        license = 'GPL-3.0-only'
        name = $runtimeSourceAssetName
        url = $runtimeSourceUrl
        upstream = 'https://github.com/MetaCubeX/mihomo/tree/v1.19.31'
        sha256 = $expectedRuntimeSourceSha256
        bytes = $expectedRuntimeSourceBytes
    }
}
$manifestPath = Join-Path $dist 'release-manifest.json'
$manifestJson = ($manifest | ConvertTo-Json -Depth 5) + "`n"
[IO.File]::WriteAllText($manifestPath, $manifestJson, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $sourceRoot 'release-manifest.json'), $manifestJson, [Text.UTF8Encoding]::new($false))

$jsAssetPath = Join-Path $dist (Split-Path -Leaf $jsPath)
Copy-Item -LiteralPath $jsPath -Destination $jsAssetPath
$releaseChecksumPath = Join-Path $dist 'SHA256SUMS.release.txt'
$releaseHashLines = Get-ChildItem -LiteralPath $dist -File |
    Where-Object Name -ne 'SHA256SUMS.release.txt' |
    Sort-Object Name |
    ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $($_.Name)"
    }
[IO.File]::WriteAllText(
    $releaseChecksumPath,
    ([string]::Join("`n", $releaseHashLines) + "`n"),
    [Text.UTF8Encoding]::new($false)
)

$sourceChecksumPath = Join-Path $sourceRoot 'SHA256SUMS.txt'
$sourceHashLines = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File |
    Where-Object {
        $_.FullName -ne $sourceChecksumPath -and
        $_.FullName -ne $runtimePath -and
        $_.FullName -ne $runtimeSourceArchivePath -and
        $_.FullName -notlike "$dist*" -and
        $_.FullName -notlike "$work*" -and
        -not $_.FullName.StartsWith($gitMetadataPrefix, [StringComparison]::OrdinalIgnoreCase)
    } |
    Sort-Object FullName |
    ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($sourceRoot, $_.FullName).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $relative"
    }
[IO.File]::WriteAllText(
    $sourceChecksumPath,
    ([string]::Join("`n", $sourceHashLines) + "`n"),
    [Text.UTF8Encoding]::new($false)
)

Write-Host "Built: $asset"
Write-Host "Manifest: $manifestPath"
Write-Host "UFI-Tools front end: $jsAssetPath"
Write-Host "Release checksums: $releaseChecksumPath"
Write-Host "Mihomo corresponding source: $runtimeSourceAssetPath"
Write-Host "Mihomo source SHA-256: $expectedRuntimeSourceSha256"
Write-Host "SHA-256: $assetHash"
Write-Host "Pinned JS manifest URL: $manifestUrl"
Write-Host 'The source manifest and SHA256SUMS.txt were refreshed for the release commit.'
