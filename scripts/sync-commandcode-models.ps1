[CmdletBinding()]
param(
  [ValidateSet("Output", "Apply", "Check")]
  [string]$Mode = "Output",

  [string]$BaseUrl = "http://127.0.0.1:8000",

  [string]$OutputPath = ".\commandcode-models.generated.yml",

  [string]$ProfilePath
)

$ErrorActionPreference = "Stop"

function Assert-SafeBaseUrl {
  param([Parameter(Mandatory)][string]$Value)

  $uri = [Uri]$Value
  $loopback = $uri.IsLoopback -or @(
    "localhost",
    "127.0.0.1",
    "::1"
  ) -contains $uri.Host.ToLowerInvariant()
  if ($uri.Scheme -ne "https" -and -not $loopback) {
    throw "BaseUrl 必须使用 HTTPS；HTTP 只允许 loopback"
  }
}

function Quote-Yaml {
  param([object]$Value)
  return ($Value | ConvertTo-Json -Compress)
}

function Normalize-Block {
  param([Parameter(Mandatory)][string]$Value)
  return ((($Value -replace "`r`n", "`n") -split "`n" |
    ForEach-Object { $_.TrimEnd() }) -join "`n").Trim()
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Content
  )
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

Assert-SafeBaseUrl -Value $BaseUrl

$base = $BaseUrl.TrimEnd("/")
$headers = @{}
$clientKey = $env:AI_PROXY_API_KEY
if ([string]::IsNullOrWhiteSpace($clientKey) -and $env:API_KEYS) {
  $clientKey = ($env:API_KEYS -split "," | ForEach-Object { $_.Trim() } |
    Where-Object { $_ } | Select-Object -First 1)
}
if (-not [string]::IsNullOrWhiteSpace($clientKey)) {
  $headers.Authorization = "Bearer $clientKey"
}

$response = Invoke-RestMethod `
  -Method Get `
  -Uri "$base/commandcode/v1/models" `
  -Headers $headers
$models = @($response.data)
if ($models.Count -eq 0) {
  throw "模型接口没有返回 data"
}

$builder = New-Object System.Text.StringBuilder
[void]$builder.AppendLine("      commandcode:")
[void]$builder.AppendLine("        displayName: CommandCode Go")
[void]$builder.AppendLine("        apiKeyEnv: LOCAL_AGGREGATION_API_KEY")
[void]$builder.AppendLine("        api: openai-completions")
[void]$builder.AppendLine("        baseURL: $base/commandcode/v1/")
[void]$builder.AppendLine("        models:")

foreach ($model in $models) {
  $id = [string]$model.id
  $name = if ([string]::IsNullOrWhiteSpace([string]$model.name)) { $id } else { [string]$model.name }
  $context = if ([int64]$model.context_window -gt 0) {
    [int64]$model.context_window
  } else {
    1000000
  }
  $maxTokens = if ([int64]$model.max_output_tokens -gt 0) {
    [int64]$model.max_output_tokens
  } else {
    64000
  }
  $input = @($model.input_modalities)
  if ($input.Count -eq 0) { $input = @("text") }
  $efforts = @($model.reasoning_efforts)
  if ($efforts.Count -eq 0) { $efforts = @("off", "high", "max") }

  [void]$builder.AppendLine("          - id: $(Quote-Yaml $id)")
  [void]$builder.AppendLine("            name: $(Quote-Yaml $name)")
  [void]$builder.AppendLine("            contextWindow: $context")
  [void]$builder.AppendLine("            maxTokens: $maxTokens")
  [void]$builder.AppendLine("            input:")
  foreach ($modality in $input) {
    [void]$builder.AppendLine("              - $modality")
  }
  [void]$builder.AppendLine("            reasoningEfforts:")
  foreach ($effort in $efforts) {
    if ($effort -eq "off") {
      [void]$builder.AppendLine("              off: null")
    } else {
      [void]$builder.AppendLine("              $effort`: $effort")
    }
  }
  [void]$builder.AppendLine("            compat:")
  [void]$builder.AppendLine("              thinkingFormat: deepseek")
}
[void]$builder.AppendLine("        reasoning: high")
$block = $builder.ToString().TrimEnd()
$normalizedBlock = Normalize-Block $block

if ($Mode -eq "Output") {
  Write-Utf8NoBom -Path $OutputPath -Content ($block + "`r`n")
  Write-Host "已生成 $($models.Count) 个 CommandCode 模型：$OutputPath"
  Write-Host "未修改 DSH profile；确认内容后使用 -Mode Apply，或手动粘贴该文件内容。"
  exit 0
}

if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
  throw "Apply/Check 模式必须提供 -ProfilePath"
}
if (-not (Test-Path -LiteralPath $ProfilePath)) {
  throw "找不到 profile：$ProfilePath"
}

$profile = [System.IO.File]::ReadAllText($ProfilePath)
$pattern = '(?ms)^      commandcode:\r?\n.*?(?=^      [A-Za-z0-9_-]+:|\z)'
$match = [regex]::Match($profile, $pattern)
if (-not $match.Success) {
  throw "profile 中没有找到 commandcode provider 块"
}
$current = Normalize-Block $match.Value

if ($Mode -eq "Check") {
  if ($current -ne $normalizedBlock) {
    throw "DSH profile 中的 CommandCode 模型配置不是最新版本"
  }
  Write-Host "DSH profile 中的 CommandCode 模型配置是最新的（$($models.Count) 个模型）"
  exit 0
}

$updated = $profile.Substring(0, $match.Index) +
  $block + "`r`n" + $profile.Substring($match.Index + $match.Length)
Write-Utf8NoBom -Path $ProfilePath -Content $updated
Write-Host "已更新 DSH profile：$ProfilePath（$($models.Count) 个模型）"
