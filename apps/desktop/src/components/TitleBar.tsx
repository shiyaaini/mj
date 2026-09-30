import { useEffect, useState } from 'react'
import './TitleBar.css'

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const api = window.miHome?.window

  useEffect(() => {
    if (!api) return
    void api.isMaximized().then(setMaximized)
    return api.onMaximizedChange(setMaximized)
  }, [api])

  if (!api) return null

  return (
    <header className="title-bar" aria-label="窗口控制">
      <div className="title-bar-drag" aria-hidden />
      <div className="title-bar-controls">
        <button type="button" aria-label="最小化" onClick={() => void api.minimize()}>
          ─
        </button>
        <button type="button" aria-label="最大化" onClick={() => void api.maximize()}>
          {maximized ? '❐' : '□'}
        </button>
        <button
          type="button"
          className="close"
          aria-label="关闭到托盘"
          title="关闭到系统托盘"
          onClick={() => void api.close()}
        >
          ×
        </button>
      </div>
    </header>
  )
}
