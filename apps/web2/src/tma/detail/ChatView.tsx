import type { ReactNode } from 'react'

export type ChatRole = 'user' | 'agent' | 'tool' | 'grader' | 'system'

export interface ChatMessage {
  role: ChatRole
  /** Mono id in the header, e.g. `m12`. */
  index?: string
  text: string
  /** Green left bar and the word `evidence` in the header. */
  evidence?: boolean
  /** A tool line with `ok === false` gets the danger colour. */
  ok?: boolean | null
  avatar?: ReactNode
}

/**
 * A chat transcript: user bubbles right-aligned, agent bubbles left with a 1px border, a tool call as a
 * plain mono line between bubbles. The header of a bubble is `role · index[ · evidence]`.
 */
export function ChatView({ messages, testId }: { messages: ChatMessage[]; testId?: string }) {
  return (
    <div className="dt-chat" data-testid={testId ?? 'chat-view'}>
      {messages.map((m, i) => {
        if (m.role === 'tool') {
          return (
            <div key={i} className={m.ok === false ? 'dt-chat__tool dt-chat__tool--bad' : 'dt-chat__tool'} data-testid="chat-tool" data-ok={m.ok == null ? '' : String(m.ok)}>
              {m.text}
            </div>
          )
        }
        const cls = ['dt-chat__msg', `dt-chat__msg--${m.role}`, m.evidence && 'dt-chat__msg--evidence'].filter(Boolean).join(' ')
        return (
          <div key={i} className={cls} data-testid="chat-msg" data-role={m.role}>
            <div className="dt-chat__head">
              {m.avatar}
              <span className="dt-chat__role">{m.role}</span>
              {m.index && (
                <>
                  <span className="dt-chat__sep">·</span>
                  <span>{m.index}</span>
                </>
              )}
              {m.evidence && (
                <>
                  <span className="dt-chat__sep">·</span>
                  <span className="dt-chat__evidence">evidence</span>
                </>
              )}
            </div>
            <div className="dt-chat__body">{m.text}</div>
          </div>
        )
      })}
    </div>
  )
}
