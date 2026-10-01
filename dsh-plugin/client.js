/* DSH browser half: a modern settings surface for the whole ai-proxy project. */
window.__ModuleLoader__.load({
  id: 'ai-proxy-dsh-bridge',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useMemo, useRef, useState } = React
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
        aboutNone: '不需要 per-user key 的渠道（openrouter、anthropic、gemini）不会出现在模型列表里',
        refresh: '刷新', applying: '处理中…', loading: '正在连接本地代理…', failed: '无法连接本地代理',
        overview: '总览', models: '模型', channels: '渠道', runtime: '运行', settings: '设置',
        mode: '模式', local: '本地 Deno', external: '已有代理',
        projectRoot: '项目目录', denoPath: 'Deno', port: '端口', externalUrl: '外部地址', apiKeyEnv: 'Key 环境变量',
        start: '启动', stop: '停止', restart: '重启', save: '保存', logs: '运行日志', empty: '暂无模型',
        search: '搜索模型…', uptime: '已运行', state: '状态', excluded: '已按渠道策略隐藏',
        available: '可用', throttled: '限流', unavailable: '不可用', unprobed: '未探测',
        check: '检查状态', checking: '检查中…', checkAll: '全部渠道', checkDone: '已检查 {0} 个模型',
        checkFailed: '检查失败', checkHint: '每个模型会发一次最小请求，占用对应渠道的免费额度。',
        usage: '用量', totalTokens: 'Token', outputTokens: '输出 Token', reasoningTokens: '推理 Token',
        calls: '调用', failed: '失败', speed: '输出速度', firstToken: '首帧延迟', avgOutput: '平均输出',
        heatmap: 'Token 热力图', trend: '总量曲线', modelUsage: '模型用量', today: '今日',
        localOnly: '数据只在本机统计，不会上传。', noUsage: '还没有调用记录，在 DSH 里发一条消息后就会出现。',
        usageFailed: '读取用量失败',
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
        aboutNone: 'Channels that need a per-user key (openrouter, anthropic, gemini) are left out of the model list',
        refresh: 'Refresh', applying: 'Working…', loading: 'Connecting to the local proxy…', failed: 'Cannot reach the local proxy',
        overview: 'Overview', models: 'Models', channels: 'Channels', runtime: 'Runtime', settings: 'Settings',
        mode: 'Mode', local: 'Local Deno', external: 'Existing proxy',
        projectRoot: 'Project', denoPath: 'Deno', port: 'Port', externalUrl: 'External URL', apiKeyEnv: 'Key env',
        start: 'Start', stop: 'Stop', restart: 'Restart', save: 'Save', logs: 'Logs', empty: 'No models',
        search: 'Search models…', uptime: 'Uptime', state: 'State', excluded: 'Hidden by channel policy',
        available: 'available', throttled: 'throttled', unavailable: 'unavailable', unprobed: 'unprobed',
        check: 'Check status', checking: 'Checking…', checkAll: 'All channels', checkDone: 'Checked {0} models',
        checkFailed: 'Check failed', checkHint: 'Each model sends one minimal request and uses that channel’s free quota.',
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
.apx_chips{display:flex;gap:8px;flex-wrap:wrap}
.apx_chip{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.apx_chip b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:620}
.apx_table{width:100%;border-collapse:collapse}
.apx_table th{text-align:left;font-weight:520;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 10px 7px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.apx_table td{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12.5px;vertical-align:middle}
.apx_table tr:last-child td{border-bottom:0}
.apx_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.apx_tag{display:inline-flex;padding:2px 8px;border-radius:7px;font-size:10.5px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
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
.apx_badge{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);white-space:nowrap;color:var(--dsw-alias-label-secondary)}
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

      const load = () => {
        // A failing /usage must not be swallowed into a null that renders as
        // "no calls recorded": that is indistinguishable from a genuine empty
        // history, and it is exactly the confusion this dashboard is meant to
        // avoid. The error is kept and shown separately.
        Promise.all([api('/panel'), api('/settings'), api('/usage').catch((reason) => ({ failed: reason }))])
          .then(([panel, nextSettings, usage]) => {
            setData(panel)
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
        api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
          .then((next) => { if (next && next.state) setSettings(next) })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => { setBusy(false); loadRef.current() })
      }
      const save = () => act('/settings', {
        mode: settings?.mode,
        projectRoot: settings?.projectRoot,
        denoPath: settings?.denoPath,
        port: settings?.port,
        externalUrl: settings?.externalUrl,
        apiKeyEnv: settings?.apiKeyEnv,
      })

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
          : h('table', { className: 'apx_table' },
            h('thead', null, h('tr', null,
              h('th', null, 'ID'), h('th', null, 'Name'), h('th', null, t('state')),
              h('th', null, 'Context'), h('th', null, 'Max'), h('th', null, 'Input'))),
            h('tbody', null, filtered.map((row) => h('tr', { key: row.id },
              h('td', { className: 'apx_mono' }, row.id),
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
              h('td', null, h('span', { className: 'apx_tag' }, (row.inputModalities || ['text']).join('+'))))))),
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
                  h('td', { className: 'apx_mono' }, row.model),
                  h('td', null, String(row.calls)),
                  h('td', null, row.speed === null ? '—' : `${row.speed} tok/s`),
                  h('td', null, formatMs(row.firstTokenMs)),
                  h('td', null, formatTokens(row.output)),
                  h('td', { className: row.failed > 0 ? 'apx_state err' : null },
                    row.failed > 0 ? String(row.failed) : '—'))))))
            : null)

      const runtimeCard = h('div', { className: 'apx_card' },
        h('div', { className: 'apx_sechead' }, h('h3', null, t('runtime'))),
        h('div', { className: 'apx_grid' },          h('div', { className: 'apx_stat' }, h('span', null, t('state')), h('b', { className: `apx_state ${tone}` }, runtime.state || 'unknown')),
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
