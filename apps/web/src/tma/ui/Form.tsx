import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { IconCheck, IconChevronDown, IconSearch } from './icons'

/** Label above a control (13 px muted, gap 6), optional hint or error under it. */
export function Field({ label, hint, error, htmlFor, children }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="tma-field">
      {label && (
        <label className="tma-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error ? <span className="tma-field__error">{error}</span> : hint ? <span className="tma-field__hint">{hint}</span> : null}
    </div>
  )
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { compact?: boolean; mono?: boolean }

/** Input h40 (h36 when compact), bg page, 1px line-strong, radius 8; focus = green border + soft ring. */
export function Input({ compact, mono, className, ...rest }: InputProps) {
  const cls = ['tma-input', compact && 'tma-input--h36', mono && 'tma-input--mono', className].filter(Boolean).join(' ')
  return <input className={cls} {...rest} />
}

export function Textarea({ mono, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={['tma-input', mono && 'tma-input--mono', className].filter(Boolean).join(' ')} {...rest} />
}

/** Search input with the 16 px magnifier at left 12. */
export function SearchInput({ width = 280, ...rest }: InputProps & { width?: number | string }) {
  return (
    <span className="tma-search" style={{ width }}>
      <IconSearch />
      <Input type="search" {...rest} />
    </span>
  )
}

export interface SelectOption {
  value: string
  label: ReactNode
  /** Mono 11 px line under the label (model id). */
  meta?: ReactNode
  /** 12 px muted note at the right (e.g. "latest"). */
  note?: ReactNode
  disabled?: boolean
}

/**
 * Dropdown of design brief 1.5: trigger like an input + 12 px chevron (open = green border);
 * menu surface-raised, radius 8, pad 4, level-2 shadow, rows 44 px (or 36 px when `compact`),
 * selected row = surface bg + green check. Closes on outside pointerdown and on Escape.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = 'Select',
  compact,
  menuCompact,
  disabled,
  id,
  'aria-label': ariaLabel,
}: {
  value: string | null
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  compact?: boolean
  menuCompact?: boolean
  disabled?: boolean
  id?: string
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const listId = useId()
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const current = options.find((o) => o.value === value)
  return (
    <div className="tma-select" ref={ref}>
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        className={['tma-input', 'tma-select__trigger', compact && 'tma-input--h36'].filter(Boolean).join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={current ? 'tma-select__value' : 'tma-select__value tma-select__placeholder'}>{current ? current.label : placeholder}</span>
        <IconChevronDown className="tma-select__chevron" />
      </button>
      {open && (
        <div className={menuCompact ? 'tma-menu tma-menu--compact' : 'tma-menu'} role="listbox" id={listId}>
          {options.map((o) => (
            <button
              type="button"
              role="option"
              key={o.value}
              aria-selected={o.value === value}
              disabled={o.disabled}
              className="tma-menu__item"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              <span className="tma-menu__text">
                <span className="tma-menu__label">{o.label}</span>
                {o.meta && <span className="tma-menu__meta">{o.meta}</span>}
              </span>
              {o.note && <span className="tma-menu__note">{o.note}</span>}
              {o.value === value && <IconCheck className="tma-menu__check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Checkbox 16x16 radius 4; checked = green fill + on-primary tick. */
export function Checkbox({ checked, onChange, label, disabled, ...rest }: { checked: boolean; onChange: (checked: boolean) => void; label?: ReactNode; disabled?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'checked' | 'type'>) {
  return (
    <label className="tma-checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} {...rest} />
      <span className="tma-checkbox__box">{checked && <IconCheck width={10} height={10} />}</span>
      {label}
    </label>
  )
}

/** Radio card (Visibility): pad 16, radius 8, selected border green, 14 px circle with 6 px dot. */
export function RadioCard({ checked, onSelect, title, description, disabled }: { checked: boolean; onSelect: () => void; title: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={checked} disabled={disabled} className="tma-radio-card" onClick={onSelect}>
      <span className="tma-radio-card__circle" />
      <span>
        <span className="tma-radio-card__title">{title}</span>
        {description && <span className="tma-radio-card__desc" style={{ display: 'block' }}>{description}</span>}
      </span>
    </button>
  )
}
