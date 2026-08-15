import { useMemo } from 'react'
import { Gauge, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ActionNotice, Empty, FetchError, Loading, TableFrame } from '@/components/env/shared'
import {
  CONTEXT_KINDS,
  setMcpEnabled,
  setSkillVisibility,
  type ActionResult,
  type ContextKind,
  type ContextLine,
  type ContextReport,
} from '@/lib/api'
import { formatTokens, percent } from '@/lib/format'
import { useAction } from '@/lib/use-action'
import type { Resource } from '@/lib/use-resource'

const KIND_BAR: Record<ContextKind, string> = {
  skill: 'bg-chart-1',
  mcp: 'bg-chart-2',
  agent: 'bg-chart-3',
  command: 'bg-chart-4',
  memory: 'bg-chart-5',
}

type ContextTabProps = {
  resource: Resource<ContextReport>
  probe: boolean
  onMeasure: () => void
  onChanged: () => void
}

export function ContextTab({ resource, probe, onMeasure, onChanged }: ContextTabProps) {
  const action = useAction(onChanged)
  const report = resource.data

  const unmeasuredMcp = useMemo(
    () => (report?.lines ?? []).filter((line) => line.kind === 'mcp' && !line.measured),
    [report]
  )

  if (!report) {
    if (resource.error) {
      return <FetchError message={resource.error} onRetry={resource.reload} />
    }
    return <Loading label="reading what your clients load on every turn" />
  }

  const clients = Object.entries(report.byClient) as Array<[string, number]>
  const measuring = probe && resource.loading

  return (
    <div className="flex flex-col gap-4">
      {resource.error ? <FetchError message={resource.error} onRetry={resource.reload} /> : null}
      {action.feedback ? (
        <ActionNotice feedback={action.feedback} onDismiss={action.dismiss} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Context per turn</CardTitle>
          <CardDescription>
            What your skills, MCP servers, subagents, commands and memory files send the model before
            you have typed anything.
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              variant={report.probed ? 'outline' : 'default'}
              size="sm"
              disabled={measuring}
              onClick={onMeasure}
            >
              {measuring ? <Loader2 className="animate-spin" /> : <Gauge />}
              {measuring ? 'starting servers…' : 'Measure MCP servers'}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-heading text-4xl leading-none text-muted-foreground">≈</span>
            <span className="font-heading text-6xl leading-none font-medium tabular-nums">
              {formatTokens(report.total)}
            </span>
            <span className="text-sm text-muted-foreground">
              estimated tokens, every turn, before you say anything
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {report.total.toLocaleString()} tokens across {report.lines.length} items in{' '}
            {report.clients.length ? report.clients.join(', ') : 'no detected client'} ·{' '}
            <span className="font-mono">{report.projectRoot}</span>
          </p>

          <p className="text-xs text-muted-foreground">
            Every figure here is an estimate from Yard&rsquo;s own tokenizer approximation, not a
            billed count.{' '}
            {report.probed
              ? 'MCP servers were started and their real tool lists were read.'
              : 'MCP servers were not started, so their cost is a flat placeholder.'}
          </p>

          {!report.probed && unmeasuredMcp.length ? (
            <p className="text-xs text-muted-foreground">
              Measuring starts {unmeasuredMcp.length} configured MCP server
              {unmeasuredMcp.length === 1 ? '' : 's'} on this machine — the same commands your client
              runs — and asks each for its tool list. Nothing is started until you click.
            </p>
          ) : null}

          {report.notes.map((note) => (
            <p key={note} className="text-xs text-muted-foreground">
              {note}
            </p>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>By kind</CardTitle>
            <CardDescription>estimated tokens per turn</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
              {CONTEXT_KINDS.map((kind) => {
                const tokens = report.byKind[kind]
                if (!tokens) {
                  return null
                }
                return (
                  <div
                    key={kind}
                    className={KIND_BAR[kind]}
                    style={{ width: `${percent(tokens, report.total)}%` }}
                    title={`${kind}: ≈${formatTokens(tokens)} tokens`}
                  />
                )
              })}
            </div>
            <Table>
              <TableBody>
                {CONTEXT_KINDS.map((kind) => (
                  <TableRow key={kind}>
                    <TableCell className="w-6">
                      <span className={`block size-2.5 rounded-full ${KIND_BAR[kind]}`} />
                    </TableCell>
                    <TableCell>{kind}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      ≈{formatTokens(report.byKind[kind])}
                    </TableCell>
                    <TableCell className="w-16 text-right text-muted-foreground tabular-nums">
                      {percent(report.byKind[kind], report.total)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>By client</CardTitle>
            <CardDescription>estimated tokens per turn</CardDescription>
          </CardHeader>
          <CardContent>
            {clients.length === 0 ? (
              <Empty>No client configuration was found on this machine.</Empty>
            ) : (
              <Table>
                <TableBody>
                  {clients.map(([client, tokens]) => (
                    <TableRow key={client}>
                      <TableCell>{client}</TableCell>
                      <TableCell className="w-full">
                        <span className="block h-2.5 rounded-full bg-muted">
                          <span
                            className="block h-2.5 rounded-full bg-chart-2"
                            style={{ width: `${percent(tokens, report.total)}%` }}
                          />
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        ≈{formatTokens(tokens)}
                      </TableCell>
                      <TableCell className="w-16 text-right text-muted-foreground tabular-nums">
                        {percent(tokens, report.total)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>What it is spent on</CardTitle>
          <CardDescription>
            Ranked by estimated cost. Turning an item off writes to the file that decides it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TableFrame height="max-h-[32rem]">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Est. tokens</TableHead>
                  <TableHead>Basis</TableHead>
                  <TableHead className="text-right">Control</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      Nothing is loaded into context.
                    </TableCell>
                  </TableRow>
                ) : (
                  report.lines.map((line) => {
                    const basis = basisOf(line)
                    const control = controlFor(line)
                    return (
                      <TableRow key={line.id}>
                        <TableCell className="max-w-[22rem]">
                          <span className="block truncate font-medium" title={line.id}>
                            {line.label}
                          </span>
                          {line.detail ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {line.detail}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{line.kind}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{line.client}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          ≈{formatTokens(line.tokens)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={basis.variant} title={basis.hint}>
                            {basis.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {control ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              title={line.remedy}
                              disabled={action.pending === line.id}
                              onClick={() => action.run(line.id, control.run)}
                            >
                              {action.pending === line.id ? (
                                <Loader2 className="animate-spin" />
                              ) : null}
                              {control.label}
                            </Button>
                          ) : (
                            <span
                              className="text-xs text-muted-foreground"
                              title="no one-click switch — this one is turned off by editing or moving its file"
                            >
                              —
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </TableFrame>
        </CardContent>
      </Card>
    </div>
  )
}

type Basis = {
  label: string
  variant: 'secondary' | 'outline' | 'destructive'
  hint: string
}

/**
 * An unprobed MCP server is the one number in the report that is not derived
 * from anything the user has on disk, so it is labelled hardest.
 */
function basisOf(line: ContextLine): Basis {
  if (line.kind === 'mcp') {
    return line.measured
      ? {
          label: 'tools read',
          variant: 'secondary',
          hint: 'estimated from the tool list the running server returned',
        }
      : {
          label: 'not measured',
          variant: 'destructive',
          hint: 'a flat placeholder, not this server. measure the servers to replace it',
        }
  }
  if (line.measured) {
    return {
      label: 'from file',
      variant: 'outline',
      hint: 'estimated from the text this item puts in the listing',
    }
  }
  return {
    label: 'from size',
    variant: 'outline',
    hint: 'estimated from the file size, because the file is loaded whole',
  }
}

/**
 * Only offer a switch where the environment layer says one exists — a
 * plugin-owned or non-Claude skill carries no remedy, and guessing would write
 * to the wrong client's config.
 */
function controlFor(line: ContextLine): { label: string; run: () => Promise<ActionResult> } | undefined {
  if (!line.remedy) {
    return undefined
  }
  if (line.kind === 'skill') {
    return { label: 'turn off', run: () => setSkillVisibility(line.label, 'off') }
  }
  if (line.kind === 'mcp') {
    return { label: 'disable', run: () => setMcpEnabled(line.label, false) }
  }
  return undefined
}
