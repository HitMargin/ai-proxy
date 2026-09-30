/* Minimal DSH browser half: settings and runtime controls for the bridge. */
window.__ModuleLoader__.load({
  id: 'ai-proxy-dsh-bridge',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React
    const NS = 'settings.aiProxyBridge'
    const DICT = {
      zh: {
        nav: 'CommandCode 桥接', title: 'CommandCode via ai-proxy',
        subtitle: '本地代理模型、账号、运行状态和生命周期',
        refresh: '刷新', loading: '正在读取本地代理…', failed: '无法连接本地代理',
        state: '运行状态', models: '模型', accounts: '账号', generated: '更新时间', empty: '暂无数据',
        mode: '运行模式', local: '本地 Deno 项目', external: '已有代理',
        projectRoot: '项目目录', denoPath: 'Deno 路径', port: '端口', externalUrl: '外部地址',
        save: '保存并应用', start: '启动', stop: '停止', restart: '重启', settings: '运行设置',
      },
      en: {
        nav: 'CommandCode bridge', title: 'CommandCode via ai-proxy',
        subtitle: 'Local proxy models, accounts, runtime state, and lifecycle',
        refresh: 'Refresh', loading: 'Reading local proxy…', failed: 'Cannot reach the local proxy',
        state: 'Runtime state', models: 'Models', accounts: 'Accounts', generated: 'Updated', empty: 'No data',
        mode: 'Mode', local: 'Local Deno project', external: 'Existing proxy',
        projectRoot: 'Project directory', denoPath: 'Deno path', port: 'Port', externalUrl: 'External URL',
        save: 'Save and apply', start: 'Start', stop: 'Stop', restart: 'Restart', settings: 'Runtime settings',
      },
    }

    async function api(path, init = {}) {
      const response = await fetch(`/api/ai-proxy-commandcode${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers || {}) },
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      return payload
    }

    function Panel(props) {
      const t = props.t
      const [data, setData] = useState(null)
      const [settings, setSettings] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const load = () => {
        setBusy(true)
        Promise.all([api('/panel'), api('/settings')])
          .then(([panel, nextSettings]) => { setData(panel); setSettings(nextSettings); setError('') })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setBusy(false))
      }
      useEffect(() => { load() }, [])
      const act = (path, body) => {
        setBusy(true)
        api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
          .then((next) => { setSettings(next); load() })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setBusy(false))
      }
      const save = () => act('/settings', {
        mode: settings?.mode,
        projectRoot: settings?.projectRoot,
        denoPath: settings?.denoPath,
        port: settings?.port,
        externalUrl: settings?.externalUrl,
        apiKeyEnv: settings?.apiKeyEnv,
      })
      const rows = Array.isArray(data?.models) ? data.models : []
      const accounts = Array.isArray(data?.accounts) ? data.accounts : []
      const runtime = data?.runtime || settings || {}
      return h('div', { style: { display: 'grid', gap: '16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('div', null, h('h2', { style: { margin: 0 } }, t('title')),
            h('p', { style: { margin: '4px 0 0', opacity: 0.7 } }, t('subtitle'))),
          h('button', { type: 'button', onClick: load, disabled: busy }, busy ? '…' : t('refresh'))),
        error ? h('div', { role: 'alert' }, `${t('failed')}: ${error}`) : null,
        settings ? h('fieldset', { style: { display: 'grid', gap: '8px' } },
          h('legend', null, t('settings')),
          h('label', null, `${t('mode')}: `, h('select', { value: settings.mode || 'local', onChange: (event) => setSettings({ ...settings, mode: event.target.value }) },
            h('option', { value: 'local' }, t('local')), h('option', { value: 'external' }, t('external')))),
          settings.mode === 'local' ? h('label', null, `${t('projectRoot')}: `, h('input', { value: settings.projectRoot || '', onChange: (event) => setSettings({ ...settings, projectRoot: event.target.value }) })) : null,
          settings.mode === 'local' ? h('label', null, `${t('denoPath')}: `, h('input', { value: settings.denoPath || 'deno', onChange: (event) => setSettings({ ...settings, denoPath: event.target.value }) })) : null,
          h('label', null, `${t('port')}: `, h('input', { type: 'number', value: settings.port || 8000, onChange: (event) => setSettings({ ...settings, port: Number(event.target.value) }) })),
          settings.mode === 'external' ? h('label', null, `${t('externalUrl')}: `, h('input', { value: settings.externalUrl || '', onChange: (event) => setSettings({ ...settings, externalUrl: event.target.value }) })) : null,
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', { type: 'button', onClick: save, disabled: busy }, t('save')),
            h('button', { type: 'button', onClick: () => act('/start'), disabled: busy }, t('start')),
            h('button', { type: 'button', onClick: () => act('/stop'), disabled: busy }, t('stop')),
            h('button', { type: 'button', onClick: () => act('/restart'), disabled: busy }, t('restart')))) : null,
        data === null ? h('div', null, t('loading')) : h('div', { style: { display: 'grid', gap: '12px' } },
          h('div', null, `${t('state')}: `, h('strong', null, runtime.state || 'unknown'),
            ` · ${t('models')}: `, h('strong', null, String(data.modelCount ?? rows.length)),
            ` · ${t('accounts')}: `, h('strong', null, String(accounts.length)),
            ` · ${t('generated')}: `, h('code', null, data.generatedAt || '—')),
          runtime.lastError ? h('div', { role: 'alert' }, runtime.lastError) : null,
          h('div', { style: { display: 'grid', gap: '6px' } }, rows.length === 0 ? h('div', null, t('empty')) : rows.slice(0, 100).map((row) =>
            h('div', { key: row.id, style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
              h('code', null, row.id), h('span', null, row.name || ''),
              h('span', { style: { opacity: 0.65 } }, `${Math.round(Number(row.contextWindow ?? 0) / 1024)}K`),
              h('span', { style: { opacity: 0.65 } }, (row.inputModalities || ['text']).join('+')))))))
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICT), 'ai-proxy bridge: dictionaries')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'ai-proxy-commandcode', order: 34,
        label: () => t('nav'), locale: NS,
      }, () => h(Panel, { t })))
    }

    return { apply, inject: ['slots', 'locale'], name: 'ai-proxy-dsh-bridge' }
  },
})
