import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import './ScrollToTop.css'

const SHOW_AFTER_PX = 160

interface Props {
  /** Scrollable container selector; defaults to main content pane */
  targetSelector?: string
}

export function ScrollToTop({ targetSelector = '.main-pane' }: Props) {
  const location = useLocation()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = document.querySelector<HTMLElement>(targetSelector)
    if (!el) {
      setVisible(false)
      return
    }

    const update = () => {
      const canScroll = el.scrollHeight > el.clientHeight + 8
      setVisible(canScroll && el.scrollTop > SHOW_AFTER_PX)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)

    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [targetSelector, location.pathname, location.search, location.hash])

  if (!visible) return null

  return (
    <button
      type="button"
      className="scroll-top-btn"
      aria-label="回到顶部"
      title="回到顶部"
      onClick={() => {
        const el = document.querySelector<HTMLElement>(targetSelector)
        el?.scrollTo({ top: 0, behavior: 'smooth' })
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          d="M12 5v14M6 11l6-6 6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
