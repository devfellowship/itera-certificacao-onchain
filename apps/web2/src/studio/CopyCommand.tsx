/**
 * The copy-command control of the studio (C5-T3, ADR-5). Studio v1 has no Save and no Run: it shows the exact
 * command the user runs on their own host, and copies it with navigator.clipboard. The command stays in a
 * selectable <pre>, so a blocked clipboard still leaves a way to copy it by hand.
 */
import { useState } from 'react'

export function CopyCommand({ command, title, testId }: { command: string; title?: string; testId?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'blocked'>('idle')
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(command)
      setState('copied')
    } catch {
      setState('blocked')
    }
  }
  return (
    <div className="stu-copy" data-copy-command data-testid={testId}>
      <div className="stu-copy__head">
        <span className="tma-label">{title ?? 'Command'}</span>
        <button type="button" className="stu-copy__btn" onClick={() => void copy()} data-testid="copy-command-button">
          {state === 'copied' ? 'Copied' : 'Copy command'}
        </button>
      </div>
      <pre className="stu-copy__pre" tabIndex={0} data-testid="copy-command-text">
        {command}
      </pre>
      {state === 'blocked' && (
        <p className="tma-body-sm tma-muted" data-testid="copy-command-blocked">
          The browser blocked the clipboard. Select the command above and copy it.
        </p>
      )}
    </div>
  )
}
