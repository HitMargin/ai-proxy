/* DSH browser half: a modern settings surface for the whole ai-proxy project. */
window.__ModuleLoader__.load({
  id: 'ai-proxy-dsh-bridge',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React
    const NS = 'settings.aiProxyBridge'
    const DICT = {
      zh: {
        nav: 'ai-proxy', tagline: '本地多 Provider 代理的运行面板',
        about: '这个插件做什么',
        aboutText: '把 DSH 接到本机的 ai-proxy Deno 项目上。插件本身不保存任何上游凭据，只负责三件事：把 DSH 的模型选择器接到代理的模型目录、把对话请求转发到正确的上游渠道、在设置里管理代理的启动与停止。',
        aboutList: '自动发现 kilo、zen、cnb、commandcode、deepseek-web、tokenharbor 等渠道的模型',
        aboutList2: '按模型前缀把请求路由回原始代理，保持协议转换、工具调用与账号池逻辑不变',
        aboutList3: '自动启动或复用本地 Deno 服务，只停止自己启动的进程',
        aboutList4: '不读取、不显示任何上游 key、OAuth 文件或 Cookie',
        aboutNone: '不需要 per-user key 的渠道（openrouter、tokenharbor）不会出现在模型列表里',
        refresh: '刷新', applying: '处理中…', loading: '正在连接本地代理…', failed: '无法连接本地代理',
        overview: '总览', models: '模型', channels: '渠道', runtime: '运行', settings: '设置',
        mode: '模式', local: '本地 Deno', external: '已有代理',
        projectRoot: '项目目录', denoPath: 'Deno', port: '端口', externalUrl: '外部地址', apiKeyEnv: 'Key 环境变量',
        start: '启动', stop: '停止', restart: '重启', save: '保存', logs: '运行日志', empty: '暂无模型',
        search: '搜索模型…', uptime: '已运行', state: '状态', excluded: '已从列表移除', listingFailed: '列表拉取失败',
        available: '可用', throttled: '限流', unavailable: '不可用', unprobed: '未探测',
        check: '检查状态', checking: '检查中…', checkAll: '全部渠道', checkDone: '已检查 {0} 个模型',
        checkFailed: '检查失败', checkHint: '每个模型会发一次最小请求，占用对应渠道的免费额度。',
        usage: '用量', totalTokens: 'Token', outputTokens: '输出 Token', reasoningTokens: '推理 Token',
        calls: '调用', failed: '失败', speed: '输出速度', firstToken: '首帧延迟', avgOutput: '平均输出',
        heatmap: 'Token 热力图', trend: '总量曲线', modelUsage: '模型用量', today: '今日',
        localOnly: '数据只在本机统计，不会上传。', noUsage: '还没有调用记录，在 DSH 里发一条消息后就会出现。',
        usageFailed: '读取用量失败',
        efforts: '推理档位', noEfforts: '—',
        channels: '渠道显示', channelsHint: '取消勾选的渠道不会出现在模型列表里。保存后立即生效。',
        clearKey: '清除',
    customVendors: '自定义供应商',
    customVendorsHint: '填入任意 OpenAI 兼容上游。模型会以 自定义供应商/<名字>/<模型> 出现在选择器里，加完点保存即可，无需重启。名字只能用小写字母、数字、点、横线、下划线。',
    addVendor: '添加供应商',
    removeVendor: '删除',
    testVendor: '测试连接',
    enabled: '启用',
    vendorOk: '连通 · {count} 个模型 · {ms}ms',
    vendorFailed: '失败：{error}',
    vendorBadName: '名字只能用 a-z 0-9 . _ - 且不超过 32 位',
    vendorBadUrl: '地址必须是 https（本机回环可以用 http）',
    vendorRejected: '下列配置未生效：{list}',
    vendorFromFile: '来自配置文件 {file}（在那个文件里改，这里只读）',
    vendorNoKey: '文件里没配 key',
        keySet: '已设置（{what}）。留空保存不会清除它。',
        keyMissing: '未设置。没有 key 时该渠道不列模型。',
        // ---- cloudflared 隧道 ----
        tunnel: 'Cloudflared 隧道',
        tunnelHint: '把本代理暴露到公网。快速隧道的地址每次启动都会变；填了 Worker 名字就会自动把 BACKEND_URL 写过去。',
        tunnelStart: '开启隧道',
        tunnelStarting: '正在启动…',
        tunnelStop: '关闭隧道',
        tunnelSyncWorker: '重写 Worker 地址',
        tunnelState: '隧道状态',
        tunnelWorker: 'Worker 回写',
        workerName: 'Worker 名字',
        cloudflaredPath: 'cloudflared 路径',
        cloudflaredAuto: '留空则自动查找',
        copy: '复制',
        deepseekSetup: '一键配置',
    deepseekRecapture: '重新配置',
    deepseekRecaptureConfirm: '重新配置会覆盖现有的 cookie / token / 浏览器头。确定继续？',
        deepseekRunning: '正在配置…',
        deepseekReady: '登录态已就绪。',
    traeCheckin: '每日签到 +100',
    traeCheckedIn: '今日已签到',
    traeCheckedInToday: '今日已签到。',
    traeCheckinAvailable: '今日未签到，签到可得 {credits} 积分。',
    traeClaimed: '签到成功，+{credits} 积分。',
    traeBalance: '积分余额 {total}',
    traeBalanceUnknown: '积分余额读取失败（不是 0）。',
    traeNotSignedIn: '未登录。运行 deno run -A .tmp-trae-login.ts 抓取凭据。',
    traeExpired: '凭据已过期，请重新运行登录脚本。',
    traeLoading: '读取账号状态…',
    traeRefresh: '刷新',
    traeHint: '积分是免费的：每月 500 + 每天签到 150。按钮不消耗推理额度；上游高峰限流（9074）会自动退避重试。',
    workbuddyLogin: '一键登录',
    workbuddyRunning: '正在登录…',
    workbuddyNotSignedIn: '未登录。点击后浏览器会打开 WorkBuddy 中国版登录页（轮询式，最长 5 分钟）。',
    workbuddyReady: '已登录。{nickname} · {count} 个模型可用。',
    workbuddyExpired: '凭据已过期，请重新登录。',
    workbuddyLoading: '读取账号状态…',
    workbuddyRefresh: '刷新',
    workbuddyHint: '凭据写入仓库根目录的 workbuddy-auth.json（已 gitignore）。代理会静默续期；模型目录取自账号自身。',
    commandcodeLogin: '一键登录',
    commandcodeWaiting: '等待浏览器回调…（最多 10 分钟）',
    commandcodeSignedIn: '已登录。账号已写入 commandcode-accounts.json。',
    commandcodeOpenLink: '打开登录页',
    commandcodeCancel: '取消',
    commandcodeAccounts: '{count} 个账号可用',
    loginPopupBlocked: '浏览器拦截了新窗口，请点下面的链接手动打开。',
        deepseekMissing: '缺少：{what}',
        deepseekHint: '会打开浏览器，扫码登录后自动保存 cookie / token / 浏览器头。过程见「日志」。',
        speedNote: '输出速度只统计解码窗口 ≥250ms 且速率 ≤250 tok/s 的调用；窗口太短的一次性回答不算速度。',
      },
      en: {
        nav: 'ai-proxy', tagline: 'Runtime panel for the local multi-provider proxy',
        about: 'What this plugin does',
        aboutText: 'Connects DSH to your local ai-proxy Deno project. The plugin never stores upstream credentials; it only does three things: publishes the proxy model catalog to the DSH picker, forwards each conversation to the right upstream channel, and lets you start or stop the proxy from settings.',
        aboutList: 'Auto-discovers models across kilo, zen, cnb, commandcode, deepseek-web and tokenharbor',
        aboutList2: 'Routes each model by its prefix back to the original proxy, leaving protocol conversion, tool calls and account pooling untouched',
        aboutList3: 'Starts or reuses the local Deno service, and only stops the process it started itself',
        aboutList4: 'Never reads or displays any upstream key, OAuth file or cookie',
        aboutNone: 'Channels that need a per-user key (openrouter, tokenharbor) are left out of the model list',
        refresh: 'Refresh', applying: 'Working…', loading: 'Connecting to the local proxy…', failed: 'Cannot reach the local proxy',
        overview: 'Overview', models: 'Models', channels: 'Channels', runtime: 'Runtime', settings: 'Settings',
        mode: 'Mode', local: 'Local Deno', external: 'Existing proxy',
        projectRoot: 'Project', denoPath: 'Deno', port: 'Port', externalUrl: 'External URL', apiKeyEnv: 'Key env',
        start: 'Start', stop: 'Stop', restart: 'Restart', save: 'Save', logs: 'Logs', empty: 'No models',
        search: 'Search models…', uptime: 'Uptime', state: 'State', excluded: 'Removed from the list', listingFailed: 'listing failed',
        efforts: 'Efforts', noEfforts: '—',
        channels: 'Channels', channelsHint: 'Unchecked channels are withheld from the model list. Takes effect on save.',
        clearKey: 'Clear',
    customVendors: 'Custom providers',
    customVendorsHint: 'Any OpenAI-compatible upstream. Its models appear in the picker as 自定义供应商/<name>/<model>. Saving is enough — no restart. A name may use lowercase letters, digits, dot, dash and underscore.',
    addVendor: 'Add provider',
    removeVendor: 'Remove',
    testVendor: 'Test',
    enabled: 'Enabled',
    vendorOk: 'Reachable · {count} models · {ms}ms',
    vendorFailed: 'Failed: {error}',
    vendorBadName: 'a name may use a-z 0-9 . _ - and at most 32 characters',
    vendorBadUrl: 'the address must be https (loopback may use http)',
    vendorRejected: 'These entries did not take effect: {list}',
    vendorFromFile: 'From the config file {file} — edit it there, this row is read-only',
    vendorNoKey: 'no key in the file',
        keySet: 'Set ({what}). Saving with the field empty leaves it alone.',
        keyMissing: 'Not set. Without a key the channel lists no models.',
        tunnel: 'Cloudflared tunnel',
        tunnelHint: 'Expose this proxy to the internet. A quick tunnel gets a new address on every start; set a Worker name to have BACKEND_URL written automatically.',
        tunnelStart: 'Start tunnel',
        tunnelStarting: 'Starting…',
        tunnelStop: 'Stop tunnel',
        tunnelSyncWorker: 'Rewrite Worker address',
        tunnelState: 'Tunnel state',
        tunnelWorker: 'Worker sync',
        workerName: 'Worker name',
        cloudflaredPath: 'cloudflared path',
        cloudflaredAuto: 'leave empty to auto-detect',
        copy: 'Copy',
        deepseekSetup: 'Set up',
    deepseekRecapture: 'Re-capture',
    deepseekRecaptureConfirm:
      'Re-capturing replaces the current cookie / token / browser headers. Continue?',
        deepseekRunning: 'Setting up…',
        deepseekReady: 'Login state is ready.',
    traeCheckin: 'Daily check-in',
    traeCheckedIn: 'Checked in today',
    traeCheckedInToday: 'Checked in today.',
    traeCheckinAvailable: 'Not checked in today; {credits} credits available.',
    traeClaimed: 'Checked in, +{credits} credits.',
    traeBalance: 'Credit balance {total}',
    traeBalanceUnknown: 'Balance lookup failed (this is not 0).',
    traeNotSignedIn: 'Not signed in. Run: deno run -A .tmp-trae-login.ts',
    traeExpired: 'Credential expired; run the sign-in script again.',
    traeLoading: 'Reading account state…',
    traeRefresh: 'Refresh',
    traeHint: 'Credits are free: 500 a month plus 150 a day for checking in. The button spends no inference quota; a peak-hour limit (9074) is retried with backoff.',
    workbuddyLogin: 'Sign in',
    workbuddyRunning: 'Signing in…',
    workbuddyNotSignedIn: 'Not signed in. The browser opens the WorkBuddy China sign-in page (polling, up to 5 minutes).',
    workbuddyReady: 'Signed in. {nickname} · {count} model(s) available.',
    workbuddyExpired: 'Credential expired; sign in again.',
    workbuddyLoading: 'Reading account state…',
    workbuddyRefresh: 'Refresh',
    workbuddyHint: 'The credential is written to workbuddy-auth.json in the project root (gitignored). The proxy renews it silently; the model list comes from the account itself.',
    commandcodeLogin: 'Sign in',
    commandcodeWaiting: 'Waiting for the browser callback… (up to 10 minutes)',
    commandcodeSignedIn: 'Signed in. The account was written to commandcode-accounts.json.',
    commandcodeOpenLink: 'Open the sign-in page',
    commandcodeCancel: 'Cancel',
    commandcodeAccounts: '{count} account(s) ready',
    loginPopupBlocked: 'The browser blocked the new window; use the link below.',
        deepseekMissing: 'Missing: {what}',
        deepseekHint: 'Opens a browser, waits for a QR scan, then saves the cookie, token and header set. Progress is in the log.',
        available: 'available', throttled: 'throttled', unavailable: 'unavailable', unprobed: 'unprobed',
        check: 'Check status', checking: 'Checking…', checkAll: 'All channels', checkDone: 'Checked {0} models',
        checkFailed: 'Check failed', checkHint: 'Each model sends one minimal request and uses that channel’s free quota.',
        rosterNow: 'Model list after restart', rosterFailed: 'Could not read the model list',
        rosterNow: 'Model list after restart', rosterFailed: 'Could not read the model list',
        usage: 'Usage', totalTokens: 'Tokens', outputTokens: 'Output', reasoningTokens: 'Reasoning',
        calls: 'Calls', failed: 'Failed', speed: 'Output speed', firstToken: 'First token', avgOutput: 'Avg output',
        heatmap: 'Token heatmap', trend: 'Cumulative', modelUsage: 'Per model', today: 'Today',
        localOnly: 'Counted on this machine only; nothing is uploaded.', noUsage: 'No calls recorded yet — send a message in DSH and this fills in.',
        usageFailed: 'Could not read usage',
        speedNote: 'Output speed only counts calls whose decode window is ≥250ms and whose rate is ≤250 tok/s; a one-shot answer is not evidence of speed.',
      },
    }

    const CSS = `
.apx{display:flex;flex-direction:column;gap:22px;max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}
.apx *{box-sizing:border-box}
.apx_hero{position:relative;display:flex;flex-direction:column;gap:14px;padding:22px 24px;border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:linear-gradient(150deg,var(--dsw-alias-bg-layer-3),var(--dsw-alias-bg-layer-1));overflow:hidden}
.apx_hero::after{content:"";position:absolute;inset:-40% -10% auto auto;width:280px;height:280px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent),transparent 68%);pointer-events:none}
.apx_head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;position:relative}
.apx_title{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em}
.apx_tag{margin:2px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
// The TRAE card reports a claim outcome in colour, so the two states need a
// rule. Without them the tags render in the default muted grey and a failed
// check-in is indistinguishable from a hint line.
.apx_tag.ok{color:var(--dsw-alias-state-success-primary)}
.apx_tag.danger{color:var(--dsw-alias-state-error-primary)}
.apx_actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.apx_stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;position:relative}
.apx_stat{display:flex;flex-direction:column;gap:3px;padding:11px 13px;border-radius:13px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.apx_stat span{font-size:10.5px;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.apx_stat b{font-size:19px;font-weight:640;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.apx_stat i{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.apx_tabs{display:inline-flex;gap:2px;padding:3px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);align-self:flex-start;flex-wrap:wrap}
.apx_tabs button{font:inherit;font-size:12px;padding:5px 13px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s ease,color .15s ease}
.apx_tabs button[aria-selected="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgb(0 0 0 / 14%)}
.apx_card{display:flex;flex-direction:column;gap:12px;padding:16px 17px;border-radius:15px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}
.apx_sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.apx_sechead h3{margin:0;font-size:13px;font-weight:640}
.apx_sechead em{margin-left:auto;font-style:normal;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.apx_text{margin:0;font-size:12.5px;line-height:1.75;color:var(--dsw-alias-label-secondary)}
.apx_list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.apx_list li::marker{color:var(--dsw-alias-state-business-primary)}
.apx_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.apx_field{display:flex;flex-direction:column;gap:5px}
.apx_field>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.apx_input,.apx_select{font:inherit;font-size:12.5px;padding:7px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);width:100%;min-width:0}
.apx_input:focus,.apx_select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.apx_btn{font:inherit;font-size:12.5px;padding:7px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .15s ease,background .15s ease,opacity .15s ease}
.apx_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}
.apx_btn:disabled{opacity:.55;cursor:progress}
.apx_btn.primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}
.apx_btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.apx_row{display:flex;gap:9px;flex-wrap:wrap;align-items:center}
/* One bordered block per vendor: several vendors coexist, so each needs a visible
   boundary or the fields of two of them read as one form. */
.apx_cvrow{display:flex;flex-direction:column;gap:7px;padding:10px;margin-top:8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.apx_cvname{max-width:190px}
.apx_cvheader{max-width:190px}
.apx_cvrow .apx_toggle{flex:0 0 auto;margin-left:auto}
.apx_bad{color:var(--dsw-alias-state-error-primary)}
/* A file-backed row: dashed border so it reads as "not edited here". */
.apx_cvfile{border-style:dashed}
.apx_chips{display:flex;gap:8px;flex-wrap:wrap}
.apx_chip{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.apx_chip b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:620}
.apx_table{width:100%;border-collapse:collapse;table-layout:auto}
/* A six-column roster of long ids does not fit a narrow panel. Scrolling the
   table sideways keeps every column readable, where squeezing them turned the
   id into one character per line. */
.apx_scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -2px}
/* The id is the row's identity and must stay on one line; min-width is what
   stops the auto layout from trading it away for the other columns, which is
   what put it on three lines in the first place. */
.apx_table .apx_id{white-space:nowrap;min-width:15em}
.apx_table th{text-align:left;font-weight:520;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 10px 7px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.apx_table td{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12.5px;vertical-align:middle}
/* Long ids broke one character per line: overflow-wrap:anywhere lets the
   browser shrink a column to nothing, and it then wins the width contest
   against every other column. Break only at the channel separator instead,
   and let the id keep its natural width. */
.apx_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-tertiary);overflow-wrap:break-word;word-break:normal}
.apx_table tr:last-child td{border-bottom:0}
.apx_tag{display:inline-flex;padding:2px 8px;border-radius:7px;font-size:10.5px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.apx_efforts{white-space:nowrap}
.apx_muted{color:var(--dsw-alias-label-tertiary)}
.apx_toggles{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px}
.apx_toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}
.apx_toggle em{font-style:normal;font-size:10.5px;opacity:.65;font-variant-numeric:tabular-nums}
.apx_dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 18%,transparent)}
.apx_state{display:inline-flex;align-items:center;gap:7px;font-size:12px}
.apx_state.ok{color:var(--dsw-alias-state-success-primary)}
.apx_state.warn{color:var(--dsw-alias-state-warning-primary)}
.apx_state.err{color:var(--dsw-alias-state-error-primary)}
.apx_callout{display:flex;gap:10px;padding:11px 13px;border-radius:12px;font-size:12px;line-height:1.55;border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);overflow-wrap:anywhere}
.apx_callout.warn{border-color:var(--dsw-alias-state-warning-primary);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 10%,transparent)}
.apx_logs{max-height:240px;overflow:auto;padding:11px 13px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.apx_empty{padding:26px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l2);border-radius:13px}
.apx_skel{height:12px;border-radius:6px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2));background-size:200% 100%;animation:apx-skel 1.2s linear infinite}
.apx_badge{display:inline-flex;align-items:center;gap:5px;padding:1px 7px;border-radius:999px;font-size:10.5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.apx_badge .apx_dot{background:currentColor;box-shadow:none}
.apx_badge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.apx_badge.warn{color:var(--dsw-alias-state-warning-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 40%,transparent)}
.apx_badge.err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.apx_badge.idle{color:var(--dsw-alias-label-tertiary)}
.apx_lat{font-style:normal;opacity:.7;font-variant-numeric:tabular-nums}
.apx_legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.apx_heat{display:grid;grid-template-rows:repeat(7,1fr);grid-auto-flow:column;grid-auto-columns:1fr;gap:3px;overflow-x:auto;padding-bottom:2px}
.apx_cell{aspect-ratio:1;border-radius:3px;background:var(--dsw-alias-bg-layer-1);min-width:9px}
.apx_cell.l1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.apx_cell.l2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent)}
.apx_cell.l3{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,transparent)}
.apx_cell.l4{background:var(--dsw-alias-state-business-primary)}
.apx_scale{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.apx_scale i{width:9px;height:9px;border-radius:3px;display:block}
.apx_spark{width:100%;height:78px;display:block;overflow:visible}
.apx_spark .apx_area{fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.apx_spark .apx_line{fill:none;stroke:var(--dsw-alias-state-business-primary);stroke-width:1.6;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.apx_spark .apx_base{stroke:var(--dsw-alias-border-l1);stroke-width:1;stroke-dasharray:3 4}
.apx_metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.apx_metric{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.apx_metric span{font-size:10.5px;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.apx_metric b{font-size:17px;font-weight:640;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.apx_metric em{font-style:normal;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
@keyframes apx-skel{from{background-position:200% 0}to{background-position:-200% 0}}
`

    async function api(path, init = {}) {
      const response = await fetch(`/api/ai-proxy${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers || {}) },
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      return payload
    }

    function formatTokens(value) {
      const tokens = Number(value ?? 0)
      if (!Number.isFinite(tokens) || tokens <= 0) return '—'
      if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
      if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
      return String(tokens)
    }

    /**
     * Bucket a day's tokens onto a five-step scale.
     *
     * The cut points are quartiles of the non-zero days rather than a fixed
     * ceiling: a fixed one makes a light week look empty and a heavy one
     * saturate, and the grid is the only place the shape of usage is visible.
     */
    function heatLevel(value, cuts) {
      if (!(value > 0)) return ''
      for (let i = 0; i < cuts.length; i += 1) if (value <= cuts[i]) return `l${i + 1}`
      return 'l4'
    }

    function heatCuts(cells) {
      const positive = cells.map((cell) => cell.tokens).filter((value) => value > 0).sort((a, b) => a - b)
      if (positive.length === 0) return []
      const at = (fraction) => positive[Math.min(positive.length - 1, Math.floor(positive.length * fraction))]
      return [at(0.25), at(0.5), at(0.75)]
    }

    function Heatmap(props) {
      const cells = props.cells
      if (!Array.isArray(cells) || cells.length === 0) return null
      const cuts = heatCuts(cells)
      // The grid is column-per-week with seven rows, oldest column first, so
      // a day always lands on the weekday it fell on.
      const cellsByDay = h('div', { className: 'apx_heat' }, cells.map((cell) => h('div', {
        key: cell.day,
        className: `apx_cell ${heatLevel(cell.tokens, cuts)}`,
        title: `${cell.day} · ${formatTokens(cell.tokens)}`,
      })))
      return h(React.Fragment, null,
        cellsByDay,
        h('div', { className: 'apx_row', style: { justifyContent: 'flex-end', marginTop: '6px' } },
          h('span', { className: 'apx_scale' }, '少',
            h('i', { className: 'apx_cell' }),
            h('i', { className: 'apx_cell l1' }),
            h('i', { className: 'apx_cell l2' }),
            h('i', { className: 'apx_cell l3' }),
            h('i', { className: 'apx_cell l4' }),
            '多')),
      )
    }

    /** Cumulative-token area chart. A single point draws as a flat line. */
    function Sparkline(props) {
      const points = props.points
      if (!Array.isArray(points) || points.length < 2) return null
      const width = 100
      const height = 30
      const pad = 1
      const max = Math.max(...points.map((p) => p.tokens), 1)
      const min = Math.min(...points.map((p) => p.tokens))
      const span = max - min || 1
      const x = (i) => pad + (i * (width - pad * 2)) / Math.max(1, points.length - 1)
      const y = (value) => height - pad - ((value - min) * (height - pad * 2)) / span
      const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.tokens).toFixed(2)}`).join(' ')
      const area = `${line} L${x(points.length - 1).toFixed(2)},${height} L${x(0).toFixed(2)},${height} Z`
      const last = points[points.length - 1]
      return h('svg', {
        className: 'apx_spark',
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        role: 'img',
      },
        h('line', { className: 'apx_base', x1: 0, x2: width, y1: height, y2: height }),
        h('path', { className: 'apx_area', d: area }),
        h('path', { className: 'apx_line', d: line }),
        h('title', null, `${formatTokens(last.tokens)} tokens`),
      )
    }

    function formatMs(value) {
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
    }

    function toneOf(state) {
      const value = String(state || '').toLowerCase()
      if (value === 'running' || value === 'external' || value === 'available') return 'ok'
      if (value === 'starting' || value === 'stopping' || value === 'degraded') return 'warn'
      if (value === 'error' || value === 'unavailable' || value === 'stopped') return 'err'
      return ''
    }

    // A model verdict is a different axis from the runtime state: the runtime
    // can be perfectly `running` while every upstream model is throttled, so
    // it gets its own badge rather than reusing the runtime dot.
    const MODEL_STATES = {
      available: { cls: 'ok', zh: '可用', en: 'Available' },
      degraded: { cls: 'warn', zh: '限流', en: 'Throttled' },
      unavailable: { cls: 'err', zh: '不可用', en: 'Unavailable' },
      unknown: { cls: 'idle', zh: '未探测', en: 'Unprobed' },
    }

    function modelStateLabel(state, t) {
      const entry = MODEL_STATES[String(state || 'unknown').toLowerCase()]
      return entry ? t(entry.zh) : String(state || '—')
    }

    function modelStateClass(state) {
      const entry = MODEL_STATES[String(state || 'unknown').toLowerCase()]
      return entry ? entry.cls : 'idle'
    }

    function countProbed(payload) {
      const models = payload && typeof payload.models === 'object' ? payload.models : {}
      return Object.values(models)
        .reduce((total, rows) => total + (rows && typeof rows === 'object' ? Object.keys(rows).length : 0), 0)
    }

    function formatUptime(startedAt, now) {
      const started = Number(startedAt || 0)
      if (!Number.isFinite(started) || started <= 0) return '—'
      const seconds = Math.max(0, Math.round((Number(now || Date.now()) - started) / 1000))
      if (seconds < 60) return `${seconds}s`
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    }

    function Panel(props) {
      const t = props.t
      const [tab, setTab] = useState('overview')
      const [data, setData] = useState(null)
      const [settings, setSettings] = useState(null)
      const [usage, setUsage] = useState(null)
      const [usageError, setUsageError] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [checking, setChecking] = useState(false)
      const [query, setQuery] = useState('')
      const [tick, setTick] = useState(() => Date.now())
      // A ref keeps one stable timer for the panel's lifetime; a state-held
      // handle would be rebuilt on every render and never let the second
      // elapse. `loadRef` likewise keeps the interval from closing over a stale
      // closure, which is what left the panel frozen until a tab switch.
      const loadRef = useRef(() => {})
      // Whether the vendor/key drafts have been seeded from a server snapshot yet.
      //
      // A ref, not state. This used to be `useState(false)` read from inside the
      // polling effect below - and that effect has an empty dependency array, so it
      // runs once at mount and its closure keeps the `false` it captured forever.
      // `setHydrated(true)` re-renders the panel but cannot reach into a closure
      // that already exists, so the guard kept reading "not hydrated yet" while the
      // inner `prev !== null` test made every reseed a no-op. Net effect: a vendor
      // list that only appeared once the poll happened to land.
      //
      // A ref is the same mutable object for the life of the component, so every
      // closure - the mount-time one included - reads its current value. Adding
      // `hydrated` to the effect's dependencies instead would tear down and rebuild
      // the polling loop on every render, which is a different bug.
      const hydratedRef = useRef(false)

      // The seeding function is installed into a ref *later*, once the two setters it
      // closes over exist. See `seedRef` below: `setHiddenChannels` and
      // `setCustomProviders` are declared further down this component, and a closure
      // that named them from here would be in their temporal dead zone - fine only
      // while nothing calls it, which is exactly the class of bug this file has been
      // bitten by before (a `const` calling a later `const` throws at call time and
      // `node --check` cannot see it).
      const seedRef = useRef(() => {})

      const load = () => {
        // A failing /usage must not be swallowed into a null that renders as
        // "no calls recorded": that is indistinguishable from a genuine empty
        // history, and it is exactly the confusion this dashboard is meant to
        // avoid. The error is kept and shown separately.
        Promise.all([api('/panel'), api('/settings'), api('/usage').catch((reason) => ({ failed: reason }))])
          .then(([panel, nextSettings, usage]) => {
            setData(panel)
            // Seed here as well as in the poll - see seedDrafts. `load` runs at
            // mount and after every action, so this is what closes the ten-second
            // gap that made a configured vendor look unconfigured on re-entry.
            seedRef.current(panel)
            setSettings(nextSettings)
            if (usage && usage.failed) {
              setUsageError(usage.failed instanceof Error ? usage.failed.message : String(usage.failed))
              setUsage(null)
            } else if (usage) {
              setUsageError('')
              setUsage(usage)
            }
            setError('')
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setTick(Date.now()))
      }
      loadRef.current = load

      const refresh = () => { setBusy(true); load() }

      // Probing is user-initiated and metered: every model answers with one
      // minimal request, so this never runs on a timer. An empty channel list
      // means "every channel", and the panel reloads once the verdicts land.
      const runProbe = (channels) => {
        setChecking(true)
        setBusy(true)
        api('/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channels, limit: 0 }),
        })
          .then((next) => { setNotice(t('checkDone').replace('{0}', String(countProbed(next)))) })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => { setChecking(false); setBusy(false); loadRef.current() })
      }

      // Runtime facts (uptime, in-flight, cooling) are per-second data, so the
      // clock is re-rendered every second and the snapshot is re-read on a
      // slower cadence. A snapshot fetch fans out to every channel's model
      // list, so polling it at 1 Hz would hammer the upstream for no gain.
      useEffect(() => {
        loadRef.current()
        const clock = setInterval(() => setTick(Date.now()), 1000)
        return () => clearInterval(clock)
      }, [])

      useEffect(() => {
        let cancelled = false
        const poll = async () => {
          while (!cancelled) {
            await new Promise((resolve) => setTimeout(resolve, 10000))
            if (cancelled) return
            // Usage is polled with the panel. Leaving it out made the dashboard
            // read the single snapshot taken when the settings page opened, so
            // a call made after that first load never appeared: the tab kept
            // reporting "no calls recorded" no matter how many turns ran.
            try {
              const [panel, usage] = await Promise.all([
                api('/panel'),
                api('/usage').catch((reason) => ({ failed: reason })),
              ])
              if (cancelled) return
              setData(panel)
              // Seeding is shared with `load` (see seedDrafts) rather than
              // duplicated here: two copies of this rule is how the two halves drifted
              // apart the last time, and only one of them was ever executed.
              seedRef.current(panel)
              if (usage && usage.failed) {
                setUsageError(usage.failed instanceof Error ? usage.failed.message : String(usage.failed))
                setUsage(null)
              } else if (usage) {
                setUsageError('')
                setUsage(usage)
              }
            } catch (reason) {
              if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
            }
          }
        }
        void poll()
        return () => { cancelled = true }
      }, [])

      const act = (path, body) => {
        setBusy(true)
        setNotice('')
        api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
          .then((next) => {
          if (next && next.state) setSettings(next)
          // A restart now reports what the proxy can see, per channel. Without
          // this the button looks like a no-op whenever a channel is down.
          if (next?.roster) {
            const r = next.roster
            setNotice(
              r.error
                ? `${t('rosterFailed')}: ${r.error}`
                : `${t('rosterNow')}: ${r.count}${r.added?.length ? ` · +${r.added.length}` : ''}${r.removed?.length ? ` · -${r.removed.length}` : ''}`,
            )
          }
        })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => { setBusy(false); loadRef.current() })
      }
      // Held separately from `settings` because the panel owns the choice locally
      // until Save is pressed, the same as every other field on this card.
      const [hiddenChannels, setHiddenChannels] = useState(null)
      const [customProviders, setCustomProviders] = useState(null)
      const channelList = Array.isArray(data?.allChannels) ? data.allChannels : []
      const hiddenNow = hiddenChannels ?? (Array.isArray(data?.hiddenChannels) ? data.hiddenChannels : [])
      const toggleChannel = (channel) => setHiddenChannels(
        hiddenNow.includes(channel)
          ? hiddenNow.filter((entry) => entry !== channel)
          : [...hiddenNow, channel],
      )
      // Keys are write-only from here: the server reports whether one is set and
      // never sends the value back, so a field starts empty every time and an empty
      // submission leaves whatever is stored alone. One per channel - a shared
      // variable would hand one upstream's key to another.
      const [channelKeys, setChannelKeys] = useState({})
      const keyedList = Array.isArray(data?.keyedChannels) ? data.keyedChannels : []
      const setChannelKey = (channel, value) => setChannelKeys((prev) => ({ ...prev, [channel]: value }))
      const clearChannelKey = (channel) => {
        setChannelKeys((prev) => ({ ...prev, [channel]: '' }))
        act('/settings', { channelKeys: { [channel]: '' } })
      }
      // ---- 自定义供应商（多个） ----
      //
      // Hydrated once from the server snapshot, then owned locally until Save -
      // the same discipline every other field on this card follows. A new row
      // starts empty rather than as a copy of an existing one: duplicating a
      // vendor would duplicate its name too, and two rows with one name is the
      // collision the proxy rejects.
      //
      // Seed the editable drafts from one server snapshot, exactly once.
      //
      // Installed here, not where `seedRef` is declared, because it closes over
      // `setHiddenChannels` / `setCustomProviders` above - naming them earlier would
      // be a temporal-dead-zone reference that only throws when called.
      //
      // Called from the panel load as well as from the poll: the load is what runs at
      // mount and after every action, the poll only fires on a ten-second timer. When
      // seeding lived *only* in the poll, re-entering the settings page showed an
      // empty vendor card for up to ten seconds - and pressing any button (a channel
      // toggle included) appeared to "make the config show up", because the action
      // reloaded the panel. The button was never the cause; it just skipped the wait.
      //
      // The `prev !== null` test is kept and is load-bearing: it is what stops a
      // snapshot arriving mid-edit from stomping a field the user has typed into but
      // not yet saved.
      seedRef.current = (panel) => {
        if (hydratedRef.current) return
        if (!Array.isArray(panel?.hiddenChannels)) return
        setHiddenChannels(panel.hiddenChannels)
        const seeded = Array.isArray(panel.customProviders) ? panel.customProviders : []
        setCustomProviders((prev) => prev !== null
          ? prev
          : seeded.map((row) => ({
            ...row,
            // The server never sends a key back, only whether one is set, so
            // the field starts blank and an empty submission leaves the stored
            // one alone.
            apiKey: '',
            authHeader: row.authHeader ?? '',
          })))
        hydratedRef.current = true
      }
      const customDrafts = Array.isArray(customProviders) ? customProviders : []
      // Mirrors the server's rule so a bad row is visible before Save, not after.
      // The server still enforces it - this is the message, not the fence.
      //
      // Declared **before** updateDraft, which calls it: both are `const`, so a
      // reference from the earlier one to the later one throws at call time
      // (`Cannot access 'customProblem' before initialization`). It reads fine on
      // the page and only fails when the user first types into a field.
      const customProblem = (row) => {
        const name = String(row?.name ?? '').trim().toLowerCase()
        if (name === '') return null
        if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(name)) return t('vendorBadName')
        const raw = String(row?.baseUrl ?? '').trim()
        if (raw === '') return null
        try {
          const url = new URL(raw)
          const loop = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
          if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loop)) return t('vendorBadUrl')
        } catch { return t('vendorBadUrl') }
        return null
      }
      const updateDraft = (index, patch) => setCustomProviders((prev) => {
        const rows = Array.isArray(prev) ? [...prev] : []
        rows[index] = { ...rows[index], ...patch, test: undefined, problem: customProblem({ ...rows[index], ...patch }) }
        return rows
      })
      const addDraft = () => setCustomProviders((prev) => [
        ...(Array.isArray(prev) ? prev : []),
        { name: '', baseUrl: '', apiKey: '', authHeader: '', enabled: true },
      ])
      const removeDraft = (index) => setCustomProviders((prev) => {
        const rows = (Array.isArray(prev) ? [...prev] : []).filter((_, i) => i !== index)
        // Removing a row clears its key on the server too. Leaving the secret
        // behind for a vendor that no longer exists is a credential nobody can
        // see or delete from this page.
        const gone = (Array.isArray(prev) ? prev : [])[index]
        if (gone?.name) act('/settings', { customProviders: rows, customKeys: { [gone.name]: '' } })
        return rows
      })
      const testVendor = async (index) => {
        const row = customDrafts[index]
        if (!row?.name) return
        setBusy(true)
        try {
          // Through the proxy, never straight from the page: the upstream would
          // refuse a cross-origin request and the key would be exposed to the
          // browser's network log for no benefit.
          const result = await fetch('/api/ai-proxy/custom/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: row.name }),
          }).then((response) => response.json())
          updateDraft(index, { test: result })
        } catch (reason) {
          updateDraft(index, { test: { ok: false, error: reason instanceof Error ? reason.message : String(reason) } })
        } finally { setBusy(false) }
      }
      const deepseek = data?.deepseekWeb || { configured: false, missing: [], running: false }
      // Read per render from the panel snapshot, which is recomputed on every poll -
      // so the URL shows up while the tunnel is still coming up rather than after the
      // next ten-second tick.
      const tunnel = data?.tunnel || { state: 'stopped', url: '', baseUrl: '', worker: null, lastError: '' }
      const save = () => act('/settings', {
        mode: settings?.mode,
        projectRoot: settings?.projectRoot,
        denoPath: settings?.denoPath,
        port: settings?.port,
        externalUrl: settings?.externalUrl,
        apiKeyEnv: settings?.apiKeyEnv,
        hiddenChannels: hiddenNow,
        channelKeys,
        // The tunnel's own fields. `tunnelEnabled` is deliberately NOT sent: it is
        // owned by the start/stop routes, and a Save that carried the stale value
        // from this page's snapshot would turn off a tunnel the user just started in
        // another tab.
        workerName: settings?.workerName,
        cloudflaredPath: settings?.cloudflaredPath,
        // Only the columns the server accepts; the panel's own bookkeeping
        // (`test`, `problem`) is not part of the stored shape.
        // File-backed rows are filtered out: they belong to custom-providers.json,
        // and re-submitting them would write a second copy into settings.json - so
        // the same vendor would then exist twice, in two files, disagreeing.
        //
        // `customDrafts` falls back to [] when the state is still null. That is
        // what silently wiped the stored list: hydration never ran (see the guard
        // in the poll effect), so every save sent `customProviders: []` and
        // overwrote whatever was on disk. Sending nothing at all is the safe
        // answer when there is nothing to say - the server leaves the stored list
        // alone, exactly as it does for `channelKeys`.
        ...customProviders === null ? {} : { customProviders: customDrafts.filter((row) => row.origin !== 'file').map((row) => ({
          name: String(row.name ?? '').trim().toLowerCase(),
          baseUrl: String(row.baseUrl ?? '').trim(),
          ...row.label ? { label: row.label } : {},
          ...row.authHeader ? { authHeader: String(row.authHeader).trim() } : {},
          enabled: row.enabled !== false,
        })).filter((row) => row.name !== '' && row.baseUrl !== '') },
        // Keys travel in their own map. An empty string means "leave what is
        // stored alone" for an untouched field, which is why the rows the user
        // did not retype are absent rather than blank.
        // Same reasoning as the list above: an empty map is the honest answer for
        // "the user typed no new keys", and the server treats an absent map that
        // way. Sending `{}` instead would read as "clear every stored key".
        ...customProviders === null ? {} : { customKeys: Object.fromEntries(customDrafts
          .filter((row) => row.origin !== 'file' && typeof row.apiKey === 'string' && row.apiKey !== '')
          .map((row) => [String(row.name).trim().toLowerCase(), row.apiKey])) },
      })
      // ---- TRAE: daily check-in ----
      //
      // The account is not fetched with the ten-second panel snapshot: a claim is
      // rate limited per device and every poll that raced a click would show a
      // stale balance. It is read when the card mounts and again after a claim, so
      // the number on screen is always the number the last request returned.
      const [trae, setTrae] = useState({ loading: true, data: null, claim: null })
      const loadTrae = useCallback(async () => {
        try {
          const response = await fetch('/api/ai-proxy/trae/status')
          const payload = await response.json()
          setTrae((prev) => ({ ...prev, loading: false, data: payload }))
        } catch (reason) {
          setTrae((prev) => ({
            ...prev,
            loading: false,
            data: { configured: false, error: reason instanceof Error ? reason.message : String(reason) },
          }))
        }
      }, [])
      useEffect(() => {
        // Only when the settings card is open, so a proxy that is not running yet
        // is not asked for an account on every page load.
        if (tab === 'settings') loadTrae()
      }, [tab, loadTrae])
      const runTraeCheckin = async () => {
        setBusy(true)
        setError('')
        try {
          const response = await fetch('/api/ai-proxy/trae/checkin', { method: 'POST' })
          const payload = await response.json()
          setTrae((prev) => ({ ...prev, claim: payload }))
          // The claim response carries the refreshed balance, so the total updates
          // without a second round trip that could answer a different number.
          const balance = payload && typeof payload.balance === 'object' ? payload.balance : null
          if (balance) {
            setTrae((prev) => ({
              ...prev,
              data: prev.data ? { ...prev.data, balance, balanceKnown: true } : prev.data,
            }))
          } else {
            await loadTrae()
          }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }
      // ---- WorkBuddy: browser sign-in ----
      //
      // Read when the settings card mounts, like TRAE, rather than from the
      // ten-second snapshot: the snapshot's "configured" only says the file
      // exists, while this route reports what the proxy actually thinks of it
      // (expired, usable, how many models the account can reach).
      const [workbuddy, setWorkbuddy] = useState({ loading: true, data: null, started: false })
      const loadWorkbuddy = useCallback(async () => {
        try {
          const response = await fetch('/api/ai-proxy/workbuddy/status')
          const payload = await response.json()
          setWorkbuddy((prev) => ({ ...prev, loading: false, data: payload }))
        } catch (reason) {
          setWorkbuddy((prev) => ({
            ...prev,
            loading: false,
            data: { configured: false, error: reason instanceof Error ? reason.message : String(reason) },
          }))
        }
      }, [])
      useEffect(() => {
        if (tab === 'settings') loadWorkbuddy()
      }, [tab, loadWorkbuddy])
      // The script owns the browser window and the polling, so there is no URL for
      // the panel to offer - it just starts it and reports what the proxy says.
      // A timer rather than the snapshot loop, because the credential file appears
      // when the script finishes and a finished sign-in should show up without
      // waiting for whatever else refreshes the page.
      useEffect(() => {
        if (tab !== 'settings' || !workbuddy.started) return undefined
        const timer = setInterval(loadWorkbuddy, 4000)
        return () => clearInterval(timer)
      }, [tab, workbuddy.started, loadWorkbuddy])
      const runWorkbuddyLogin = async () => {
        setBusy(true)
        setError('')
        try {
          const response = await fetch('/api/ai-proxy/workbuddy/login', { method: 'POST' })
          const payload = await response.json()
          setWorkbuddy((prev) => ({ ...prev, started: true }));
          if (!response.ok) setError(payload?.error ?? `the sign-in request failed (${response.status})`)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }
      const setUpDeepseek = () => {
        // Re-capturing replaces working credentials. The originals are copied aside
        // first and put back if the capture does not finish, so the worst case is a
        // wasted scan - but the person still deserves to be told before it starts.
        if (deepseek.configured && !globalThis.confirm?.(t('deepseekRecaptureConfirm'))) return
        act('/deepseek-web/setup')
      }
      // CommandCode signs in through the browser, so the button cannot be a spawn:
      // the proxy hands back a URL and waits up to ten minutes for the callback.
      // The state is kept here to cover the gap between the click and the next
      // ten-second snapshot, and it carries the baseline the server reported at that
      // moment - which is how the card tells "the flow started" from "the flow
      // finished" instead of painting over the server forever.
      const [commandLogin, setCommandLogin] = useState(null)
      const startCommandLogin = async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/ai-proxy/commandcode/login', { method: 'POST' })
      const status = await response.json()
      setCommandLogin({ ...status, baseline: data?.login?.status ?? null })
      // Opened here rather than on click, so a popup blocker is the only thing that
      // can stop it - and the link is on screen either way, so nothing is lost.
      if (typeof status?.authUrl === 'string' && status.authUrl) {
        const opened = window.open(status.authUrl, '_blank', 'noopener')
        if (!opened) setError(t('loginPopupBlocked'))
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  // Cancel has to drop the local copy as well as stop the flow. Calling the route
  // without it leaves a card that still reads "waiting" over an idle server -
  // which is exactly what a broken cancel button looks like.
  const cancelCommandLogin = () => {
    setCommandLogin(null)
    act('/commandcode/login/cancel')
  }
  // The commandcode snapshot is the base of this payload, so its fields are at the
  // top level rather than under a channel name.
  //
  // The proxy is the only thing that knows whether the callback landed, so its answer
  // wins the moment it differs from what it said when we clicked. Holding the local
  // copy unconditionally is what left this card reading "waiting" after a sign-in
  // that had already succeeded, and what made cancel look broken: the route ran, the
  // server went idle, and a stale local state kept painting over it.
  const serverLogin = data?.login ?? null
  const loginView = commandLogin && (!commandLogin.baseline || serverLogin?.status === commandLogin.baseline)
    ? commandLogin
    : serverLogin ?? commandLogin
  const loginWaiting = loginView?.status === 'waiting'
  const loginSignedIn = loginView?.status === 'done' || loginView?.status === 'success'
  const commandAccounts = Array.isArray(data?.accounts)
    ? data.accounts.filter((account) => account.enabled).length
    : Number(data?.activeAccounts ?? 0)

      const rows = useMemo(() => (Array.isArray(data?.models) ? data.models : []), [data])
      const projectRows = useMemo(
        () => (Array.isArray(data?.projectModels) ? data.projectModels : []),
        [data],
      )
      const accounts = useMemo(() => (Array.isArray(data?.accounts) ? data.accounts : []), [data])
      const channels = data?.channels && typeof data.channels === 'object' ? data.channels : {}
      // Only offer a per-channel button for a channel the roster actually has;
      // probing a channel with no models would report success having checked
      // nothing, which is worse than not offering the button.
      const probeChannelOptions = useMemo(
        () => Object.keys(channels).filter((key) => (channels[key] ?? 0) > 0).slice(0, 8),
        [channels],
      )
      const runtime = data?.runtime || settings || {}
      const tone = toneOf(runtime.state)
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return projectRows.slice(0, 200)
        return projectRows.filter((row) => `${row.id} ${row.name || ''}`.toLowerCase().includes(needle)).slice(0, 200)
      }, [projectRows, query])
      const modelTotal = Number(data?.projectModelCount ?? data?.modelCount ?? projectRows.length)
      const healthCounts = useMemo(() => {
        const counts = { available: 0, degraded: 0, unavailable: 0, unknown: 0, total: 0 }
        for (const row of projectRows) {
          const state = String(row?.state ?? 'unknown').toLowerCase()
          if (state in counts) counts[state] += 1
          if (row?.state) counts.total += 1
        }
        return counts
      }, [projectRows])

      const stats = h('div', { className: 'apx_stats' },
        h('div', { className: 'apx_stat' }, h('span', null, t('state')),
          h('b', { className: `apx_state ${tone}` }, h('i', { className: 'apx_dot' }), runtime.state || 'unknown')),
        h('div', { className: 'apx_stat' }, h('span', null, t('models')), h('b', null, String(modelTotal))),
        h('div', { className: 'apx_stat' }, h('span', null, t('channels')), h('b', null, String(Object.keys(channels).length))),
        h('div', { className: 'apx_stat' }, h('span', null, t('uptime')), h('b', null, formatUptime(runtime.startedAt, tick))),
      )

      const hero = h('div', { className: 'apx_hero' },
        h('div', { className: 'apx_head' },
          h('div', null, h('h2', { className: 'apx_title' }, t('nav')), h('p', { className: 'apx_tag' }, t('tagline'))),
          h('div', { className: 'apx_actions' },
            h('button', { className: 'apx_btn', type: 'button', onClick: refresh, disabled: busy }, busy ? t('applying') : t('refresh')),
            h('button', { className: 'apx_btn primary', type: 'button', onClick: () => act('/restart'), disabled: busy }, t('restart')))),
        stats,
      )

      // What this plugin is and is not, stated before any number: the panel
      // shows a plugin that owns no credentials and no protocol logic, which is
      // the only thing that makes it safe to leave running.
      const aboutCard = h('div', { className: 'apx_card' },
        h('div', { className: 'apx_sechead' }, h('h3', null, t('about'))),
        h('p', { className: 'apx_text' }, t('aboutText')),
        h('ul', { className: 'apx_list' },
          ['aboutList', 'aboutList2', 'aboutList3', 'aboutList4'].map((key) =>
            h('li', { key }, t(key)))),
        h('div', { className: 'apx_callout warn' }, t('aboutNone')),
      )

      const tabs = h('div', { className: 'apx_tabs', role: 'tablist' },
        ['overview', 'usage', 'models', 'channels', 'runtime', 'settings'].map((key) =>
          h('button', {
            key,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === key ? 'true' : 'false',
            onClick: () => setTab(key),
          }, t(key))),
      )

      const settingsCard = settings ? h('div', { className: 'apx_card' },
        h('div', { className: 'apx_sechead' }, h('h3', null, t('settings')), h('em', null, runtime.baseUrl || '')),
        h('div', { className: 'apx_grid' },
          h('label', { className: 'apx_field' }, h('span', null, t('mode')),
            h('select', { className: 'apx_select', value: settings.mode || 'local', onChange: (event) => setSettings({ ...settings, mode: event.target.value }) },
              h('option', { value: 'local' }, t('local')), h('option', { value: 'external' }, t('external')))),
          h('label', { className: 'apx_field' }, h('span', null, t('port')),
            h('input', { className: 'apx_input', type: 'number', min: 1, max: 65535, value: settings.port || 8000, onChange: (event) => setSettings({ ...settings, port: Number(event.target.value) }) })),
          settings.mode === 'local'
            ? h('label', { className: 'apx_field' }, h('span', null, t('projectRoot')),
              h('input', { className: 'apx_input', value: settings.projectRoot || '', onChange: (event) => setSettings({ ...settings, projectRoot: event.target.value }) }))
            : h('label', { className: 'apx_field' }, h('span', null, t('externalUrl')),
              h('input', { className: 'apx_input', value: settings.externalUrl || '', onChange: (event) => setSettings({ ...settings, externalUrl: event.target.value }) })),
          settings.mode === 'local'
            ? h('label', { className: 'apx_field' }, h('span', null, t('denoPath')),
              h('input', { className: 'apx_input', value: settings.denoPath || 'deno', onChange: (event) => setSettings({ ...settings, denoPath: event.target.value }) }))
            : null,
          h('label', { className: 'apx_field' }, h('span', null, t('apiKeyEnv')),
            h('input', { className: 'apx_input', value: settings.apiKeyEnv || '', onChange: (event) => setSettings({ ...settings, apiKeyEnv: event.target.value }) })),
        ),
        channelList.length > 0
          ? h('div', { className: 'apx_field' },
            h('span', null, t('channels')),
            h('p', { className: 'apx_tag' }, t('channelsHint')),
            h('div', { className: 'apx_toggles' }, channelList.map((channel) => h('label',
              { key: channel, className: 'apx_toggle' },
              h('input', {
                type: 'checkbox',
                checked: !hiddenNow.includes(channel),
                onChange: () => toggleChannel(channel),
              }),
              h('span', null, channel),
              h('em', null, `${data?.channels?.[channel] ?? 0}`),
            ))),
          )
          : null,
        // One field per keyed channel. Each names the variable the proxy reads,
        // so it is clear that these are separate credentials and not one shared
        // secret that happens to be typed twice.
        ...keyedList.map((entry) => h('label', { key: entry.channel, className: 'apx_field' },
          h('span', null, entry.label ?? entry.channel),
          h('p', { className: 'apx_tag' },
            data?.channelKeySet?.[entry.channel]
              ? t('keySet', { what: entry.envToken })
              : t('keyMissing'),
          ),
          h('div', { className: 'apx_row' },
            h('input', {
              className: 'apx_input',
              type: 'password',
              placeholder: data?.channelKeySet?.[entry.channel] ? '••••••••' : '',
              value: channelKeys[entry.channel] ?? '',
              onChange: (event) => setChannelKey(entry.channel, event.target.value),
            }),
            data?.channelKeySet?.[entry.channel]
              ? h('button', { className: 'apx_btn', type: 'button', onClick: () => clearChannelKey(entry.channel), disabled: busy }, t('clearKey'))
              : null,
          ),
        )),
        // ---- 自定义供应商：多个，每个一行 ----
        //
        // A list rather than a single form, because the point of the feature is
        // that several upstreams coexist. Each row owns its own draft state, so
        // editing one does not disturb another, and the key field is write-only
        // the same way the keyed channels above are: the server reports whether a
        // key is set and never sends it back.
        h('div', { className: 'apx_field', key: 'custom-vendors' },
          h('span', null, t('customVendors')),
          h('p', { className: 'apx_tag' }, t('customVendorsHint')),
          customDrafts.map((draft, index) => h('div', { key: 'cv-' + index, className: 'apx_cvrow' + (draft.origin === 'file' ? ' apx_cvfile' : '') },
            draft.origin === 'file'
              ? h('p', { className: 'apx_tag' }, t('vendorFromFile', { file: data?.customFile?.path ?? 'custom-providers.json' }))
              : null,
            h('div', { className: 'apx_row' },
              h('input', {
                className: 'apx_input apx_cvname',
                placeholder: 'name (a-z0-9._-)',
                value: draft.name,
                readOnly: draft.origin === 'file',
                onChange: (event) => updateDraft(index, { name: event.target.value }),
              }),
              h('input', {
                className: 'apx_input',
                placeholder: 'https://api.example.com/v1',
                value: draft.baseUrl,
                readOnly: draft.origin === 'file',
                onChange: (event) => updateDraft(index, { baseUrl: event.target.value }),
              }),
            ),
            h('div', { className: 'apx_row' },
              h('input', {
                className: 'apx_input',
                type: 'password',
                placeholder: draft.origin === 'file'
                  ? (draft.keySet ? '••••••••' : t('vendorNoKey'))
                  : (draft.keySet ? '••••••••' : 'API key'),
                value: draft.apiKey ?? '',
                readOnly: draft.origin === 'file',
                onChange: (event) => updateDraft(index, { apiKey: event.target.value }),
              }),
              h('input', {
                className: 'apx_input apx_cvheader',
                placeholder: 'Authorization',
                value: draft.authHeader ?? '',
                onChange: (event) => updateDraft(index, { authHeader: event.target.value }),
              }),
              h('label', { className: 'apx_toggle' },
                h('input', {
                  type: 'checkbox',
                  checked: draft.enabled !== false,
                  onChange: () => updateDraft(index, { enabled: draft.enabled === false }),
                }),
                h('span', null, t('enabled')),
              ),
              h('button', {
                className: 'apx_btn',
                type: 'button',
                disabled: busy || !draft.name,
                onClick: () => testVendor(index),
              }, t('testVendor')),
              // A file-backed vendor has no Remove button: the file owns it, and
              // deleting the row would only delete a settings.json entry that does
              // not exist - the vendor would come straight back on the next read.
              draft.origin === 'file'
                ? null
                : h('button', {
                  className: 'apx_btn',
                  type: 'button',
                  disabled: busy,
                  onClick: () => removeDraft(index),
                }, t('removeVendor')),
            ),
            // Computed at render, not only on edit: a row hydrated from the server
            // (or left over from an older settings.json) never went through
            // updateDraft, so its problem would never be shown.
            customProblem(draft)
              ? h('p', { className: 'apx_tag apx_bad' }, customProblem(draft))
              : null,
            draft.test
              ? h('p', { className: 'apx_tag' },
                draft.test.ok
                  ? t('vendorOk', { count: String(draft.test.modelCount ?? 0), ms: String(draft.test.latencyMs ?? 0) })
                  : t('vendorFailed', { error: draft.test.error ?? 'unknown' }))
              : null,
          )),
          h('div', { className: 'apx_row' },
            h('button', {
              className: 'apx_btn',
              type: 'button',
              disabled: busy || customDrafts.length >= 32,
              onClick: addDraft,
            }, t('addVendor')),
          ),
          Array.isArray(data?.customRejected) && data.customRejected.length > 0
            ? h('p', { className: 'apx_tag apx_bad' },
              t('vendorRejected', { list: data.customRejected.map((r) => r.name + ': ' + r.reason).join('; ') }))
            : null,
        ),
        h('div', { className: 'apx_field' },
          h('span', null, 'TRAE'),
          h('p', { className: 'apx_tag' },
            trae.loading
              ? t('traeLoading')
              : !trae.data?.configured
              ? t('traeNotSignedIn')
              : trae.data.expired
              ? t('traeExpired')
              : ((trae.data.checkin?.checkedIn ?? trae.claim?.alreadyClaimed) ?? false)
              ? t('traeCheckedInToday')
              : t('traeCheckinAvailable', {
                credits: String(trae.data.checkin?.credits ?? trae.claim?.credits ?? '?'),
              }),
          ),
          h('div', { className: 'apx_row' },
            h('button', {
              className: 'apx_btn primary',
              type: 'button',
              onClick: runTraeCheckin,
              // Disabled once claimed, not hidden: a button that disappears is a
              // control the user has to hunt for again tomorrow.
              disabled: busy || trae.loading || !trae.data?.configured ||
                ((trae.data.checkin?.checkedIn ?? trae.claim?.alreadyClaimed) ?? false),
            }, (trae.data?.checkin?.checkedIn ?? trae.claim?.alreadyClaimed) ?? false
              ? t('traeCheckedIn')
              : t('traeCheckin')),
            h('button', {
              className: 'apx_btn',
              type: 'button',
              onClick: loadTrae,
              disabled: busy || trae.loading,
            }, t('traeRefresh')),
          ),
          // The balance is advisory, so a failed lookup says so rather than
          // showing 0 - which would read as "you have nothing".
          trae.data?.balanceKnown
            ? h('p', { className: 'apx_muted' },
              t('traeBalance', {
                total: String(Math.round(Number(trae.data.balance?.total ?? 0) * 100) / 100),
              }),
              Array.isArray(trae.data.balance?.packs) && trae.data.balance.packs.length > 0
                ? ' · ' + trae.data.balance.packs
                    .map((pack) => `${pack.name} ${pack.remaining}/${pack.total}`)
                    .join(' · ')
                : '')
            : trae.data?.configured
            ? h('p', { className: 'apx_muted' }, t('traeBalanceUnknown'))
            : null,
          // A failed claim says why. 9074 in particular looks like a broken
          // button unless the panel explains that it is a peak-hour limit.
          trae.claim && trae.claim.ok === false
            ? h('p', { className: 'apx_tag danger' }, trae.claim.message)
            : null,
          trae.claim && trae.claim.ok && !trae.claim.alreadyClaimed
            ? h('p', { className: 'apx_tag ok' }, t('traeClaimed', {
                credits: String(trae.claim.credits ?? '?'),
              }))
            : null,
          h('span', { className: 'apx_muted' }, t('traeHint')),
        ),
        h('div', { className: 'apx_field' },
          h('span', null, 'WorkBuddy'),
          h('p', { className: 'apx_tag' },
            workbuddy.loading
              ? t('workbuddyLoading')
              : workbuddy.data?.error
              ? workbuddy.data.error
              : !workbuddy.data?.configured
              ? t('workbuddyNotSignedIn')
              : workbuddy.data.expired
              ? t('workbuddyExpired')
              : t('workbuddyReady', {
                  nickname: String(workbuddy.data.nickname ?? '?'),
                  count: String(workbuddy.data.models ?? 0),
                })),
          h('div', { className: 'apx_row' },
            h('button', {
              className: 'apx_btn primary',
              type: 'button',
              onClick: runWorkbuddyLogin,
              // Stays visible once configured, for the same reason the deepseek
              // re-capture button does: the access token expires on its own.
              disabled: busy || workbuddy.loading || Boolean(workbuddy.data?.running),
            }, workbuddy.data?.running
              ? t('workbuddyRunning')
              : t('workbuddyLogin')),
            h('button', {
              className: 'apx_btn',
              type: 'button',
              onClick: loadWorkbuddy,
              disabled: busy || workbuddy.loading,
            }, t('workbuddyRefresh')),
          ),
          h('span', { className: 'apx_muted' }, t('workbuddyHint')),
        ),
        h('div', { className: 'apx_field' },
          h('span', null, 'deepseek-web'),
          h('p', { className: 'apx_tag' },
            deepseek.configured
              ? t('deepseekReady')
              : t('deepseekMissing', { what: deepseek.missing.join(', ') }),
          ),
          h('div', { className: 'apx_row' },
            h('button', {
              className: 'apx_btn',
              type: 'button',
              onClick: setUpDeepseek,
              disabled: busy || deepseek.running,
            }, deepseek.running
              ? t('deepseekRunning')
              // The state is capturable more than once - cookies and the bearer token
              // both expire, and re-running the capture is how that gets fixed. A
              // button that silently does nothing once the files exist is worse than
              // no button, so it says what it will do instead.
              : (deepseek.configured ? t('deepseekRecapture') : t('deepseekSetup'))),
            h('span', { className: 'apx_muted' }, t('deepseekHint')),
          ),
        ),
        h('div', { className: 'apx_field' },
          h('span', null, 'commandcode'),
          h('p', { className: 'apx_tag' },
            loginWaiting
              ? t('commandcodeWaiting')
              : loginSignedIn
              ? t('commandcodeSignedIn')
              : t('commandcodeAccounts', { count: String(commandAccounts) }),
          ),
          h('div', { className: 'apx_row' },
            loginWaiting
              // The sign-in page has to be reachable even if the popup was blocked,
              // and the proxy is the one that will receive the callback, so the link
              // stays on screen for the whole ten minutes.
              ? h('a', { className: 'apx_btn', href: commandLogin?.authUrl, target: '_blank', rel: 'noreferrer' }, t('commandcodeOpenLink'))
              : h('button', {
                  className: 'apx_btn',
                  type: 'button',
                  onClick: startCommandLogin,
                  disabled: busy,
                }, t('commandcodeLogin')),
            loginWaiting
              ? h('button', { className: 'apx_btn danger', type: 'button', onClick: cancelCommandLogin, disabled: busy }, t('commandcodeCancel'))
              : null,
          ),
        ),
        // ---- cloudflared 隧道 ----
        //
        // Its own buttons, not the Save button: starting a tunnel spawns a process
        // and waits for a hostname, which is not the same act as persisting a field.
        // The switch writes the setting as a side effect of starting, so the toggle
        // and the process cannot disagree about what is running.
        h('div', { className: 'apx_field', key: 'tunnel' },
          h('span', null, t('tunnel')),
          h('p', { className: 'apx_tag' }, t('tunnelHint')),
          h('div', { className: 'apx_row' },
            h('button', {
              className: 'apx_btn primary',
              type: 'button',
              onClick: () => act('/tunnel/start'),
              disabled: busy || tunnel.state === 'starting' || tunnel.state === 'running',
            }, tunnel.state === 'starting' ? t('tunnelStarting') : t('tunnelStart')),
            h('button', {
              className: 'apx_btn danger',
              type: 'button',
              onClick: () => act('/tunnel/stop'),
              disabled: busy || tunnel.state === 'stopped',
            }, t('tunnelStop')),
            tunnel.state === 'running'
              ? h('button', {
                className: 'apx_btn',
                type: 'button',
                onClick: () => act('/tunnel/sync-worker'),
                disabled: busy,
              }, t('tunnelSyncWorker'))
              : null,
          ),
          h('p', { className: 'apx_tag' },
            t('tunnelState') + ': ' + (tunnel.state || 'stopped')
            + (tunnel.pid ? ' · PID ' + tunnel.pid : '')),
          // The public address a client is pointed at, and it carries `/v1` because
          // that is the aggregate the provider registers under. Shown only once it
          // exists: an empty box reads as "the tunnel is up but broken".
          tunnel.url
            ? h('div', { className: 'apx_row' },
              h('input', {
                className: 'apx_input',
                readOnly: true,
                value: tunnel.baseUrl || tunnel.url,
                onFocus: (event) => event.target.select(),
              }),
              h('button', {
                className: 'apx_btn',
                type: 'button',
                onClick: () => { try { navigator.clipboard?.writeText(tunnel.baseUrl || tunnel.url) } catch {} },
              }, t('copy')))
            : null,
          // The Worker half fails independently of the tunnel, so it reports
          // separately: "tunnel is up, BACKEND_URL write failed" is a different fix
          // from "the tunnel never came up".
          tunnel.worker && tunnel.worker.state !== 'idle'
            ? h('p', { className: 'apx_tag' + (tunnel.worker.state === 'error' ? ' apx_bad' : '') },
              t('tunnelWorker') + ': ' + tunnel.worker.state
              + (tunnel.worker.error ? ' — ' + tunnel.worker.error : ''))
            : null,
          tunnel.lastError
            ? h('p', { className: 'apx_tag apx_bad' }, tunnel.lastError)
            : null,
          h('label', { className: 'apx_field' }, h('span', null, t('workerName')),
            h('input', {
              className: 'apx_input',
              placeholder: 'ai-api',
              value: settings.workerName || '',
              onChange: (event) => setSettings({ ...settings, workerName: event.target.value }),
            })),
          h('label', { className: 'apx_field' }, h('span', null, t('cloudflaredPath')),
            h('input', {
              className: 'apx_input',
              placeholder: t('cloudflaredAuto'),
              value: settings.cloudflaredPath || '',
              onChange: (event) => setSettings({ ...settings, cloudflaredPath: event.target.value }),
            })),
        ),
        h('div', { className: 'apx_row' },
          h('button', { className: 'apx_btn primary', type: 'button', onClick: save, disabled: busy }, t('save')),
          h('button', { className: 'apx_btn', type: 'button', onClick: () => act('/start'), disabled: busy }, t('start')),
          h('button', { className: 'apx_btn', type: 'button', onClick: () => act('/stop'), disabled: busy }, t('stop')),
          h('button', { className: 'apx_btn danger', type: 'button', onClick: () => act('/restart'), disabled: busy }, t('restart'))),
      ) : null

      const modelsCard = h('div', { className: 'apx_card' },
        h('div', { className: 'apx_sechead' },
          h('h3', null, t('models')),
          h('em', null, `${filtered.length} / ${projectRows.length}`)),
        h('div', { className: 'apx_row' },
          h('button', {
            className: 'apx_btn primary',
            type: 'button',
            onClick: () => runProbe([]),
            disabled: checking,
            title: t('checkHint'),
          }, checking ? t('checking') : t('checkAll')),
          probeChannelOptions.map((channel) => h('button', {
            key: channel,
            className: 'apx_btn',
            type: 'button',
            onClick: () => runProbe([channel]),
            disabled: checking,
          }, channel)),
          h('em', { className: 'apx_lat' }, t('checkHint'))),
        h('input', {
          className: 'apx_input',
          type: 'search',
          value: query,
          placeholder: t('search'),
          onChange: (event) => setQuery(event.target.value),
        }),
        filtered.length === 0
          ? h('div', { className: 'apx_empty' }, projectRows.length === 0 ? t('empty') : t('search'))
          : h('div', { className: 'apx_scroll' },
            h('table', { className: 'apx_table' },
              h('thead', null, h('tr', null,
                h('th', null, 'ID'), h('th', null, 'Name'), h('th', null, t('state')),
                h('th', null, 'Context'), h('th', null, 'Max'), h('th', null, 'Input'),
                h('th', null, t('efforts')))),
              h('tbody', null, filtered.map((row) => h('tr', { key: row.id },
                h('td', { className: 'apx_mono apx_id' }, row.id),
                h('td', null, row.name || ''),
                h('td', null, h('span', {
                  className: `apx_badge ${modelStateClass(row.state)}`,
                  title: row.reason || '',
                },
                  h('i', { className: 'apx_dot' }),
                  modelStateLabel(row.state, t),
                  row.latencyMs > 0 ? h('em', { className: 'apx_lat' }, `${row.latencyMs}ms`) : null)),
                h('td', null, formatTokens(row.contextWindow)),
                h('td', null, formatTokens(row.maxTokens)),
                h('td', null, h('span', { className: 'apx_tag' }, (row.inputModalities || ['text']).join('+'))),
                // The ladder the upstream actually published. Shown because a
                // wrong one is invisible until a turn is rejected: a picker can
                // offer a rung no channel serves and the request just 400s.
                h('td', { className: 'apx_efforts' },
                  Array.isArray(row.reasoningEfforts) && row.reasoningEfforts.length > 0
                    // The name is what the picker shows, so the panel shows it too.
                    // For a channel that names its rungs differently from the effort
                    // each one sends (kilo: instant/thinking -> none/high) the two
                    // columns would otherwise disagree about the same ladder.
                    ? h('span', { className: 'apx_tag' }, row.reasoningEfforts.map((effort) => (typeof effort === 'string' ? effort : effort?.name ?? effort?.id)).filter(Boolean).join(' · '))
                    : h('span', { className: 'apx_muted' }, t('noEfforts')))))))),
        healthCounts.total > 0
          ? h('div', { className: 'apx_legend' },
            h('span', null, `${t('models')}: ${healthCounts.available} ${t('available')}`),
            h('span', null, `${healthCounts.degraded} ${t('throttled')}`),
            h('span', null, `${healthCounts.unavailable} ${t('unavailable')}`),
            h('span', null, `${healthCounts.unknown} ${t('unprobed')}`))
          : h('div', { className: 'apx_legend' }, t('unprobed')),
        notice ? h('div', { className: 'apx_callout' }, notice) : null,
      )

      const channelsCard = h('div', { className: 'apx_card' },
        h('div', { className: 'apx_sechead' }, h('h3', null, t('channels'))),
        Object.keys(channels).length === 0
          ? h('div', { className: 'apx_empty' }, t('empty'))
          : h('div', { className: 'apx_chips' }, Object.entries(channels).map(([key, count]) =>
            h('span', { className: 'apx_chip', key }, h('i', { className: 'apx_dot' }), key, h('b', null, String(count))))),
        Number(data?.blockedModelCount ?? 0) > 0
          ? h('div', { className: 'apx_callout warn' }, `${t('excluded')}: ${data.blockedModelCount}`)
          : null,
        // A channel missing from the chips above is missing *because* its listing
        // failed, so the roster can look shorter with no hint why. Name it here
        // rather than letting it read as "that channel is gone".
        Object.keys(data?.catalogIssues ?? {}).length > 0
          ? h('div', { className: 'apx_callout warn' },
            Object.entries(data.catalogIssues).map(([key, issue]) =>
              h('div', { key }, `${t('listingFailed')} · ${key}: ${String(issue?.reason ?? '')}`)))
          : null,
      )

      // Usage lives in its own tab because it is the only section that keeps
      // growing: the roster and health answer "what can I use", this answers
      // "what did it cost".
      const usageSummary = usage?.summary ?? null
      // An unreachable endpoint and a genuinely empty history look identical
      // if both render as "no calls", so they are told apart here.
      const usageCard = usageError
        ? h('div', { className: 'apx_card' },
          h('div', { className: 'apx_sechead' }, h('h3', null, t('usage'))),
          h('div', { className: 'apx_callout' }, `${t('usageFailed')}: ${usageError}`))
        : !usageSummary || usageSummary.requests === 0
        ? h('div', { className: 'apx_card' }, h('div', { className: 'apx_empty' }, t('noUsage')))
        : h(React.Fragment, null,
          h('div', { className: 'apx_card' },
            h('div', { className: 'apx_sechead' },
              h('h3', null, t('usage')),
              h('em', null, t('localOnly'))),
            h('div', { className: 'apx_metrics' },
              h('div', { className: 'apx_metric' },
                h('span', null, t('totalTokens')), h('b', null, formatTokens(usageSummary.totalTokens))),
              h('div', { className: 'apx_metric' },
                h('span', null, t('outputTokens')), h('b', null, formatTokens(usageSummary.outputTokens))),
              h('div', { className: 'apx_metric' },
                h('span', null, t('reasoningTokens')), h('b', null, formatTokens(usageSummary.reasoningTokens))),
              h('div', { className: 'apx_metric' },
                h('span', null, t('calls')), h('b', null, String(usageSummary.requests)),
                usageSummary.failed > 0 ? h('em', null, `${t('failed')} ${usageSummary.failed}`) : null),
              h('div', { className: 'apx_metric' },
                h('span', null, t('speed')),
                h('b', null, usageSummary.outputSpeed === null ? '—' : `${usageSummary.outputSpeed}`),
                h('em', null, 'tok/s')),
              h('div', { className: 'apx_metric' },
                h('span', null, t('firstToken')), h('b', null, formatMs(usageSummary.firstTokenMs))),
              h('div', { className: 'apx_metric' },
                h('span', null, t('avgOutput')), h('b', null, formatTokens(usageSummary.avgOutputTokens))),
              h('div', { className: 'apx_metric' },
                h('span', null, t('today')), h('b', null, formatTokens(usageSummary.today)))),
            h('div', { className: 'apx_legend' }, t('speedNote'))),
          h('div', { className: 'apx_card' },
            h('div', { className: 'apx_sechead' }, h('h3', null, t('heatmap'))),
            h(Heatmap, { cells: usage?.heatmap })),
          usage?.trend && usage.trend.length > 1
            ? h('div', { className: 'apx_card' },
              h('div', { className: 'apx_sechead' },
                h('h3', null, t('trend')),
                h('em', null, formatTokens(usageSummary.totalTokens))),
              h(Sparkline, { points: usage.trend }))
            : null,
          (Array.isArray(usage?.models) ? usage.models : []).length > 0
            ? h('div', { className: 'apx_card' },
              h('div', { className: 'apx_sechead' }, h('h3', null, t('modelUsage'))),
              h('table', { className: 'apx_table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('models')),
                  h('th', null, t('calls')),
                  h('th', null, t('speed')),
                  h('th', null, t('firstToken')),
                  h('th', null, t('outputTokens')),
                  h('th', null, t('failed')))),
                h('tbody', null, usage.models.map((row) => h('tr', { key: row.model },
                  // Name first, id underneath: Zen publishes only an id, so the
                  // id alone is what a reader would otherwise be shown.
                  h('td', null,
                    h('div', null, row.name || row.model),
                    h('div', { className: 'apx_mono' }, row.model)),
                  h('td', null, String(row.calls)),
                  h('td', null, row.speed === null ? '—' : `${row.speed} tok/s`),
                  h('td', null, formatMs(row.firstTokenMs)),
                  h('td', null, formatTokens(row.output)),
                  h('td', { className: row.failed > 0 ? 'apx_state err' : null },
                    row.failed > 0 ? String(row.failed) : '—'))))))
            : null)

      const runtimeCard = h('div', { className: 'apx_card' },
        h('div', { className: 'apx_sechead' }, h('h3', null, t('runtime'))),
        h('div', { className: 'apx_grid' },
          h('div', { className: 'apx_stat' }, h('span', null, t('state')), h('b', { className: `apx_state ${tone}` }, runtime.state || 'unknown')),
          h('div', { className: 'apx_stat' }, h('span', null, 'PID'), h('b', null, String(runtime.pid ?? '—'))),
          h('div', { className: 'apx_stat' }, h('span', null, t('mode')), h('b', null, runtime.mode || '—')),
          h('div', { className: 'apx_stat' }, h('span', null, t('accounts')), h('b', null, String(accounts.length)))),
        h('div', { className: 'apx_sechead' }, h('h3', null, t('logs'))),
        h('div', { className: 'apx_logs' }, (runtime.logs || []).join('\n') || '—'),
      )

      const body = {
        overview: h(React.Fragment, null,
          aboutCard,
          error ? h('div', { className: 'apx_callout' }, `${t('failed')}: ${error}`) : null,
          data?.panelError || data?.projectError ? h('div', { className: 'apx_callout warn' }, data.panelError || data.projectError) : null,
          runtime.lastError ? h('div', { className: 'apx_callout' }, runtime.lastError) : null,
          data === null
            ? h('div', { className: 'apx_card' }, h('div', { className: 'apx_skel' }), h('div', { className: 'apx_skel' }), h('div', { className: 'apx_skel' }))
            : h(React.Fragment, null, channelsCard, accounts.length > 0
              ? h('div', { className: 'apx_card' },
                h('div', { className: 'apx_sechead' }, h('h3', null, t('accounts')), h('em', null, String(accounts.length))),
                h('table', { className: 'apx_table' },
                  h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, t('state')), h('th', null, 'Source'))),
                  h('tbody', null, accounts.map((account) => h('tr', { key: account.id },
                    h('td', { className: 'apx_mono' }, account.id || '—'),
                    h('td', { className: `apx_state ${account.cooling ? 'warn' : account.enabled ? 'ok' : ''}` },
                      h('i', { className: 'apx_dot' }), account.cooling ? 'cooling' : account.enabled ? 'enabled' : 'disabled'),
                    h('td', null, h('span', { className: 'apx_tag' }, account.source || '—')))))))
              : null)),
        usage: usageCard,
        models: modelsCard,
        channels: channelsCard,
        runtime: runtimeCard,
        settings: settingsCard,
      }[tab]

      return h('div', { className: 'apx' }, hero, tabs, body)
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICT), 'ai-proxy bridge: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'ai-proxy-dsh-bridge')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'ai-proxy bridge: styles')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'ai-proxy', order: 34,
        label: () => t('nav'), locale: NS,
      }, () => h(Panel, { t })))
    }

    return { apply, inject: ['slots', 'locale'], name: 'ai-proxy-dsh-bridge' }
  },
})
