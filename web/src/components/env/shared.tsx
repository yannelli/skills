import type { ReactNode } from 'react'
import { AlertCircle, Check, Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { shortenPath } from '@/lib/format'
import type { ActionFeedback } from '@/lib/use-action'

/**
 * Paths are the whole point of Yard's feedback — they are what the developer
 * greps for afterwards — so the full path is always on the element, and only
 * the visible form is shortened.
 */
export function FilePath({ file, full = false }: { file: string; full?: boolean }) {
  return (
    <span
      title={file}
      className={
        full
          ? 'font-mono text-xs break-all text-muted-foreground'
          : 'font-mono text-xs text-muted-foreground'
      }
    >
      {full ? file : shortenPath(file)}
    </span>
  )
}

export function FetchError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>could not read your configuration</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>{message}</span>
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          try again
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function Loading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </p>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="p-4 text-sm text-muted-foreground">{children}</p>
}

/** The outcome of a write, naming the file it landed in. */
export function ActionNotice({
  feedback,
  onDismiss,
}: {
  feedback: ActionFeedback
  onDismiss: () => void
}) {
  return (
    <Alert variant={feedback.ok ? 'default' : 'destructive'}>
      {feedback.ok ? <Check /> : <AlertCircle />}
      <AlertTitle>{feedback.ok ? feedback.message : 'the change was not written'}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-1">
        {feedback.ok ? null : <span>{feedback.message}</span>}
        {feedback.file ? (
          <span className="text-muted-foreground">
            wrote <FilePath file={feedback.file} full />
          </span>
        ) : null}
        {feedback.backup ? (
          <span className="text-muted-foreground">
            backup <FilePath file={feedback.backup} full />
          </span>
        ) : null}
        <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
          dismiss
        </Button>
      </AlertDescription>
    </Alert>
  )
}

/**
 * A table that scrolls inside itself. Wide config tables must never make the
 * page scroll sideways.
 */
export function TableFrame({
  height = 'max-h-[28rem]',
  children,
}: {
  height?: string
  children: ReactNode
}) {
  return (
    <div className={`w-full min-w-0 overflow-auto rounded-lg border border-border ${height}`}>
      {children}
    </div>
  )
}
