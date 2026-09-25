# ============================================================
# 读取同目录 session.json，调用 basispoints 接口
# 注意：session.json 含活 token，切勿提交到任何仓库
# ============================================================
$ErrorActionPreference = 'Stop'

# ---------- 1. 读 session ----------
$sessionPath = Join-Path $PSScriptRoot 'session.json'
if (-not (Test-Path $sessionPath)) { throw "找不到 $sessionPath" }

$session = Get-Content $sessionPath -Raw | ConvertFrom-Json
$accessToken = $session.accessToken
if ([string]::IsNullOrWhiteSpace($accessToken)) { throw "session.json 里没有 accessToken" }

# ---------- 2. JWT payload 解码 ----------
function Get-JwtPayload {
    param([Parameter(Mandatory)][string]$Token)
    $parts = $Token.Split('.')
    if ($parts.Length -ne 3) { throw "不是合法 JWT（段数=$($parts.Length)）" }

    $p = $parts[1].Replace('-', '+').Replace('_', '/')
    switch ($p.Length % 4) {
        2 { $p += '==' }
        3 { $p += '=' }
        1 { throw "base64url 长度异常" }
    }
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
}

$claims     = Get-JwtPayload -Token $accessToken
$authClaims = $claims.'https://api.openai.com/auth'

# ---------- 3. account id ----------
$accountId = $authClaims.chatgpt_account_id
if (-not $accountId) { $accountId = $session.account.id }
if (-not $accountId) { $accountId = $session.account_id }
if (-not $accountId) { throw "拿不到 chatgpt_account_id" }

# ---------- 4. 过期检查 ----------
$expUtc = [DateTimeOffset]::FromUnixTimeSeconds([int64]$claims.exp).UtcDateTime
Write-Host ("token 过期时间(UTC): {0}" -f $expUtc) -ForegroundColor DarkGray
if ($expUtc -lt [DateTime]::UtcNow) {
    throw "accessToken 已过期，请重新登录 ChatGPT 获取新 session"
}

# ---------- 5. headers ----------
$headers = @{
    'authorization'           = "Bearer $accessToken"
    'chatgpt-account-id'      = $accountId
    'x-openai-account-id'     = $accountId
    'x-basispoints-auth-mode' = 'chatgpt'
}

# ---------- 6. body（按真实接口字段填） ----------
$body = @{
    model = 'gpt-4o'
    input = 'hello'
} | ConvertTo-Json -Depth 10

# ---------- 7. 请求（HttpClient，兼容 PS 5.1 / 7） ----------
$url = 'https://bps.openai.com/basispoints/api/responses'

$handler = [System.Net.Http.HttpClientHandler]::new()
$client  = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(60)

$client.DefaultRequestHeaders.TryAddWithoutValidation('authorization',           "Bearer $accessToken") | Out-Null
$client.DefaultRequestHeaders.TryAddWithoutValidation('chatgpt-account-id',      $accountId)             | Out-Null
$client.DefaultRequestHeaders.TryAddWithoutValidation('x-openai-account-id',     $accountId)             | Out-Null
$client.DefaultRequestHeaders.TryAddWithoutValidation('x-basispoints-auth-mode', 'chatgpt')              | Out-Null
$client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent',              'ai-proxy/1.0')         | Out-Null

$jsonBody = @{
    model = 'gpt-4o'
    input = 'hello'
} | ConvertTo-Json -Depth 10

$content = [System.Net.Http.StringContent]::new($jsonBody, [Text.Encoding]::UTF8, 'application/json')

# 先构造 request 对象，再赋 Content，最后发
$req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $url)
$req.Content = $content

$response = $client.SendAsync($req).GetAwaiter().GetResult()
$statusCode = [int]$response.StatusCode
$bodyText   = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

Write-Host ("===== HTTP {0} =====" -f $statusCode) `
    -ForegroundColor $(if ($statusCode -lt 300) { 'Green' } else { 'Yellow' })
Write-Host $bodyText

# 限流相关响应头
foreach ($h in 'x-ratelimit-limit-requests','x-ratelimit-remaining-requests',
               'x-ratelimit-limit-tokens','x-ratelimit-remaining-tokens',
               'x-ratelimit-reset-requests','x-ratelimit-reset-tokens',
               'retry-after') {
    $v = $null
    if ($response.Headers.TryGetValues($h, [ref]$v)) {
        Write-Host ("  {0}: {1}" -f $h, ($v -join ', ')) -ForegroundColor DarkGray
    }
}

$client.Dispose()