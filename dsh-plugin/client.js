/* Minimal DSH browser half: one settings section backed by the bridge route. */
window.__ModuleLoader__.load({
  id: 'ai-proxy-dsh-bridge',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React
    const NS = 'settings.aiProxyBridge'
    const DICT = {
      zh: {
        nav: 'CommandCode 桥接',
        title: 'CommandCode via ai-proxy',
        subtitle: '本地代理模型、账号和健康状态',
        refresh: '刷新',
        loading: '正在读取本地代理…',
        failed: '无法连接本地代理',
        state: '状态',
        models: '模型',
        accounts: '账号',
        generated: '更新时间',
        empty: '暂无数据',
      },
      en: {
        nav: 'CommandCode bridge',
        title: 'CommandCode via ai-proxy',
        subtitle: 'Local proxy models, accounts, and health',
        refresh: 'Refresh',
        loading: 'Reading local proxy…',
        failed: 'Cannot reach the local proxy',
        state: 'State',
        models: 'Models',
        accounts: 'Accounts',
        generated: 'Updated',
        empty: 'No data',
      },
    }

    function Panel(props) {
      const t = props.t
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const load = () => {
        setBusy(true)
        fetch('/api/ai-proxy-commandcode/panel', { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const payload = await response.json()
            if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
            setData(payload)
            setError('')
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setBusy(false))
      }
      useEffect(() => { load() }, [])
      const rows = Array.isArray(data?.models) ? data.models : []
      const accounts = Array.isArray(data?.accounts) ? data.accounts : []
      return h('div', { style: { display: 'grid', gap: '16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('div', null,
            h('h2', { style: { margin: 0 } }, t('title')),
            h('p', { style: { margin: '4px 0 0', opacity: 0.7 } }, t('subtitle'))),
          h('button', { type: 'button', onClick: load, disabled: busy }, busy ? '…' : t('refresh'))),
        error ? h('div', { role: 'alert' }, `${t('failed')}: ${error}`)
          : data === null ? h('div', null, t('loading'))
          : h('div', { style: { display: 'grid', gap: '12px' } },
            h('div', null, `${t('state')}: `, h('strong', null, data.state || 'unknown'),
              ` · ${t('models')}: `, h('strong', null, String(data.modelCount ?? rows.length))),
            h('div', null, `${t('accounts')}: `, h('strong', null, String(accounts.length)),
              ` · ${t('generated')}: `, h('code', null, data.generatedAt || '—')),
            h('div', { style: { display: 'grid', gap: '6px' } },
              rows.length === 0 ? h('div', null, t('empty')) : rows.slice(0, 100).map((row) =>
                h('div', { key: row.id, style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
                  h('code', null, row.id),
                  h('span', null, row.name || ''),
                  h('span', { style: { opacity: 0.65 } }, `${Math.round(Number(row.contextWindow ?? 0) / 1024)}K`),
                  h('span', { style: { opacity: 0.65 } }, (row.inputModalities || ['text']).join('+'))))))
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICT), 'ai-proxy bridge: dictionaries')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'ai-proxy-commandcode',
        order: 34,
        label: () => t('nav'),
        locale: NS,
      }, () => h(Panel, { t })))
    }

    return { apply, inject: ['slots', 'locale'], name: 'ai-proxy-dsh-bridge' }
  },
})
