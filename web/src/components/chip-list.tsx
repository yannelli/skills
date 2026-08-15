import { Button } from '@/components/ui/button'

type ChipListProps = {
  ids: string[]
  actionLabel: string
  onAction: (id: string) => void
}

export function ChipList({ ids, actionLabel, onAction }: ChipListProps) {
  if (ids.length === 0) {
    return <p className="text-xs text-muted-foreground">None</p>
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {ids.map((id) => (
        <li key={id} className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs break-all text-foreground">{id}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => onAction(id)}>
            {actionLabel}
          </Button>
        </li>
      ))}
    </ul>
  )
}
