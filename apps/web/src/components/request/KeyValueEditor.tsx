import { Trash2 } from 'lucide-react'
import type { KeyValue } from '@/lib/types'
import { emptyKeyValue } from '@/lib/utils'

export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  disabled,
}: {
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  disabled?: boolean
}) {
  /**
   * Always keep exactly one trailing blank row.
   *
   * This removes the "add row" click from the common path — the user types, and
   * the next empty row appears underneath, the way a spreadsheet behaves.
   */
  function update(index: number, patch: Partial<KeyValue>) {
    const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row))
    const last = next[next.length - 1]
    if (last && (last.key || last.value)) next.push(emptyKeyValue())
    onChange(next)
  }

  function remove(index: number) {
    const next = rows.filter((_, i) => i !== index)
    onChange(next.length ? next : [emptyKeyValue()])
  }

  return (
    <div className="text-sm">
      <div className="grid grid-cols-[28px_1fr_1fr_32px] gap-1 border-b border-line px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
        <span className="sr-only">Enabled</span>
        <span />
        <span>Key</span>
        <span>Value</span>
        <span />
      </div>

      {rows.map((row, index) => {
        const isTrailingBlank = index === rows.length - 1 && !row.key && !row.value
        return (
          <div
            key={index}
            className="grid grid-cols-[28px_1fr_1fr_32px] items-center gap-1 border-b border-line/50 px-2 py-1 hover:bg-subtle/50"
          >
            <input
              type="checkbox"
              checked={row.enabled}
              disabled={disabled || isTrailingBlank}
              onChange={(e) => update(index, { enabled: e.target.checked })}
              className="h-3.5 w-3.5 accent-[rgb(var(--accent))] disabled:opacity-30"
              aria-label={`Enable ${row.key || 'row'}`}
            />
            <input
              value={row.key}
              disabled={disabled}
              placeholder={keyPlaceholder}
              onChange={(e) => update(index, { key: e.target.value })}
              className="bg-transparent py-0.5 font-mono text-xs outline-none placeholder:text-muted/50"
            />
            <input
              value={row.value}
              disabled={disabled}
              placeholder={valuePlaceholder}
              onChange={(e) => update(index, { value: e.target.value })}
              className="bg-transparent py-0.5 font-mono text-xs outline-none placeholder:text-muted/50"
            />
            {!isTrailingBlank && !disabled ? (
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label={`Remove ${row.key || 'row'}`}
                className="text-muted opacity-0 transition-opacity hover:text-danger focus:opacity-100 group-hover:opacity-100 [div:hover>&]:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span />
            )}
          </div>
        )
      })}
    </div>
  )
}
