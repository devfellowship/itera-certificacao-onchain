import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './icons'

/**
 * Modal: scrim rgba(10,9,8,0.72), panel surface + line-strong border, radius 12, modal shadow.
 * Closes on Escape and on a scrim click. Width defaults to 980 (Task Filter modal variant).
 */
export function Modal({ open, onClose, title, width = 980, footer, children, testId }: { open: boolean; onClose: () => void; title: ReactNode; width?: number; footer?: ReactNode; children: ReactNode; testId?: string }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="tma-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tma-modal" role="dialog" aria-modal="true" style={{ maxWidth: width }} data-testid={testId}>
        <div className="tma-modal__header">
          <span className="tma-h3">{title}</span>
          <button type="button" className="tma-icon-btn" aria-label="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="tma-modal__body">{children}</div>
        {footer && <div className="tma-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
