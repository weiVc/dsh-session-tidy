// DSH Session Tidy: one native session-menu action, one quiet per-turn action,
// and a single second-confirmation overlay. No extra pages or panels.
window.__ModuleLoader__.load({
  id: 'dsh-session-tidy',
  factory(require) {
    const React = require('react')
    const ui = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const CSS = `
.dst-turn-del {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  opacity: .35;
  transition: opacity .15s ease, color .15s ease;
}
.dst-turn-del:hover,
.dst-turn-del:focus-visible {
  opacity: 1;
  color: var(--dsw-alias-state-error-primary);
}
.dst-turn-del:focus-visible {
  outline: 2px solid var(--dsw-alias-state-error-primary);
  outline-offset: 2px;
}
@media (max-width: 640px) {
  .dst-turn-del__label { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dst-turn-del { transition: none; }
}
`

    function registerSessionTidy(ctx) {
      const text = (zh, en) => ctx.locale.getSnapshot().active === 'zh' ? zh : en
      const service = name => {
        if (typeof ctx.get !== 'function') return undefined
        try { return ctx.get(name) } catch { return undefined }
      }
      const dangerStyle = { color: 'var(--dsw-alias-state-error-primary)' }
      const listeners = new Set()
      const controller = new AbortController()
      let disposed = false
      let state = { target: null, busy: false, error: '' }

      const publish = patch => {
        if (disposed) return
        state = { ...state, ...patch }
        for (const listener of listeners) listener()
      }
      const subscribe = listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }
      const snapshot = () => state
      const openDialog = target => {
        if (disposed || state.busy) return
        publish({ target, error: '' })
      }
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

      function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
        const [, closeMenu] = useMenuOpenState()
        const label = text('删除会话…', 'Delete session…')
        return h(ui.MenuItemButton, {
          danger: true,
          icon: h(ui.IconTrashOutlineRegular, {}),
          title: label,
          'aria-label': label,
          onSelect: () => {
            closeMenu(false)
            openDialog({ kind: 'session', sessionId, title: displayTitle || sessionId })
          },
        }, label)
      }

      function DeleteTurnTail({ turn, sessionId }) {
        if (turn?.status !== 'closed' || !Number.isInteger(turn.turn)) return null
        const label = text(
          `删除本轮（第 ${turn.turn} 轮，无法恢复）`,
          `Delete this turn (turn ${turn.turn}, cannot be undone)`,
        )
        return h('div', {
          style: { display: 'flex', justifyContent: 'flex-end', padding: '2px 8px 0' },
        }, h('button', {
          type: 'button',
          className: 'dst-turn-del',
          title: label,
          'aria-label': label,
          onClick: () => openDialog({ kind: 'turn', sessionId, turn: turn.turn }),
        },
        h(ui.IconTrashOutlineRegular, { size: 16 }),
        h('span', { className: 'dst-turn-del__label' }, text('删除本轮', 'Delete this turn'))))
      }

      function DeleteDialog() {
        const current = React.useSyncExternalStore(subscribe, snapshot, snapshot)
        const target = current.target
        if (!target) return null
        const isTurn = target.kind === 'turn'
        const close = () => { if (!current.busy) publish({ target: null, error: '' }) }
        const cancelLabel = text('取消', 'Cancel')
        const confirmLabel = current.busy
          ? text('正在删除…', 'Deleting…')
          : isTurn ? text('确认删除本轮', 'Delete this turn') : text('确认永久删除', 'Confirm permanent deletion')
        return h(ui.Modal, {
          open: true,
          onClose: close,
          closeLabel: cancelLabel,
          title: isTurn
            ? text('删除本轮？', 'Delete this turn?')
            : text('永久删除会话？', 'Permanently delete session?'),
          description: isTurn
            ? text(
              '该轮的用户消息、步骤与回答将从会话日志中永久移除，后续轮次保留并顺延。若该会话正在生成，会先停止当前工作。此操作无法恢复。',
              'All messages, steps and the answer of this turn are permanently removed from the session log. Later turns are kept. If this session is generating, its current work is stopped first. This cannot be undone.',
            )
            : text(
              '会话及其全部轮次将从本机永久删除，无法恢复。运行中的任务会先安全停止。',
              'The session and all its turns will be permanently deleted from this device. Running work is stopped safely first. This cannot be undone.',
            ),
          footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(ui.Button, {
              variant: 'outline',
              disabled: current.busy,
              title: cancelLabel,
              'aria-label': cancelLabel,
              onClick: close,
            }, cancelLabel),
            h(ui.Button, {
              variant: 'outline',
              style: dangerStyle,
              disabled: current.busy,
              title: confirmLabel,
              'aria-label': confirmLabel,
              onClick: perform,
            }, confirmLabel)),
        },
        h('div', { style: { display: 'grid', gap: 8 } },
          h('p', {
            style: { margin: 0, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
          },
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } },
            isTurn ? text('目标轮次：', 'Target turn: ') : text('目标会话：', 'Target session: ')),
          isTurn ? text(`第 ${target.turn} 轮`, `Turn ${target.turn}`) : target.title),
          current.error && h('p', {
            role: 'alert',
            style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' },
          }, current.error)))
      }

      async function perform() {
        const target = state.target
        if (disposed || state.busy || !target) return
        const isTurn = target.kind === 'turn'
        // Remember whether the target is the view the user was looking at when
        // they confirmed; a session switched to meanwhile must not be yanked.
        const workspaceBefore = service('uiWorkspace')
        const wasCurrent = workspaceBefore?.selection?.getSnapshot?.().sessionId === target.sessionId
        const url = isTurn
          ? '/plugins/dsh-session-tidy/delete-turn'
          : '/plugins/dsh-session-tidy/delete-session'
        const body = isTurn
          ? { sessionId: target.sessionId, turn: target.turn }
          : { sessionId: target.sessionId }
        publish({ busy: true, error: '' })
        try {
          const response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              'x-dsh-session-tidy': isTurn ? 'delete-turn' : 'delete-session',
            },
            body: JSON.stringify(body),
          })
          const result = await response.json().catch(() => null)
          if (!response.ok || result?.ok !== true) {
            const failure = new Error(result?.error?.message || `HTTP ${response.status}`)
            failure.code = result?.error?.code
            failure.stopped = result?.error?.stopped === true
            throw failure
          }
          if (disposed) return
          publish({ target: null })
          try {
            if (isTurn) await finishTurn(target.sessionId, wasCurrent)
            else await finishSession(target.sessionId, wasCurrent)
          } catch (error) {
            console.warn('Session tidy: post-delete client cleanup failed:', error)
            if (isTurn) window.location.reload()
          }
        } catch (error) {
          if (disposed) return
          publish({ error: error?.message || String(error) })
          if (error?.stopped === true) {
            recoverView(target).catch((reason) => {
              console.warn('Session tidy: view recovery after a stopped session failed:', reason)
              window.location.reload()
            })
          }
        } finally {
          if (!disposed) publish({ busy: false })
        }
      }

      // A failure after the Host stopped the session leaves this view holding a
      // detached session; reopen it cold (the log was not modified).
      async function recoverView(target) {
        const workspace = service('uiWorkspace')
        if (!workspace || typeof workspace.clearMain !== 'function') {
          window.location.reload()
          return
        }
        const current = workspace.selection?.getSnapshot?.().sessionId
        if (current !== target.sessionId) return
        await finishTurn(target.sessionId, true)
      }

      async function finishSession(sessionId, wasCurrent) {
        const workspace = service('uiWorkspace')
        if (wasCurrent && typeof workspace?.clearMain === 'function') workspace.clearMain()
        const jobs = []
        const sessions = service('sessions')
        if (typeof sessions?.refresh === 'function') jobs.push(sessions.refresh())
        const workspaces = service('workspaces')
        if (typeof workspaces?.refresh === 'function') jobs.push(workspaces.refresh())
        const results = await Promise.allSettled(jobs)
        for (const result of results) {
          if (result.status === 'rejected') {
            console.warn('Session tidy: list refresh failed after session deletion:', result.reason)
          }
        }
      }

      async function finishTurn(sessionId, wasCurrent) {
        const workspace = service('uiWorkspace')
        const sessions = service('sessions')
        const stillCurrent = wasCurrent
          || workspace?.selection?.getSnapshot?.().sessionId === sessionId
        if (!stillCurrent) {
          // The user moved to another view while the dialog was open: refresh the
          // catalog but never pull them back to this session.
          try {
            if (typeof sessions?.refresh === 'function') await sessions.refresh()
          } catch {
            /* the deletion already succeeded */
          }
          return
        }
        if (!workspace
          || typeof workspace.clearMain !== 'function'
          || typeof workspace.openSession !== 'function') {
          window.location.reload()
          return
        }
        workspace.clearMain()
        let lastError
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await delay(150 + attempt * 50)
          try {
            if (typeof sessions?.refresh === 'function') await sessions.refresh()
          } catch (error) {
            lastError = error
          }
          try {
            workspace.openSession(sessionId)
            // The title/projection hints of the reopened session may follow the
            // removed turn; refresh the catalog in the background.
            try {
              Promise.resolve(sessions?.refresh?.()).catch(() => {})
            } catch {
              /* a refresh failure never invalidates a successful reopen */
            }
            return
          } catch (error) {
            lastError = error
          }
        }
        console.warn('Session tidy: the session did not reopen in place, reloading:', lastError)
        window.location.reload()
      }

      const dispose = () => {
        if (disposed) return
        disposed = true
        controller.abort()
        listeners.clear()
      }

      ctx.effect(() => () => dispose(), 'session-tidy: dialog lifecycle')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'session-tidy: styles')

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-tidy.delete-session',
        order: 500,
      }, DeleteSessionMenuItem))
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: 'session-tidy.delete-turn',
        order: 900,
      }, DeleteTurnTail))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-tidy.dialog',
      }, DeleteDialog))
    }

    return {
      inject: ['slots', 'sessions', 'workspaces', 'locale'],
      apply(ctx) {
        registerSessionTidy(ctx)
      },
    }
  },
})
