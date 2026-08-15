import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ActionNotice, FetchError, FilePath, Loading, TableFrame } from '@/components/env/shared'
import {
  CLIENTS,
  SCOPES,
  SKILL_VISIBILITIES,
  mcpActionBlocked,
  pluginActionBlocked,
  setMcpEnabled,
  setPluginEnabled,
  setSkillVisibility,
  skillActionBlocked,
  type Client,
  type Inventory,
  type Scope,
  type SkillVisibility,
} from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { useAction } from '@/lib/use-action'
import type { Resource } from '@/lib/use-resource'

/**
 * Row kinds are singular here because each row is one item; the API's own
 * plural `kind` vocabulary is only used for its query parameter, and this table
 * filters what it already holds.
 */
const ROW_KINDS = ['skill', 'plugin', 'mcp', 'hook', 'agent', 'command', 'memory'] as const

type RowKind = (typeof ROW_KINDS)[number]

type Control =
  | { type: 'skill'; id: string; skill: string; visibility: SkillVisibility; blocked?: string }
  | { type: 'plugin'; id: string; plugin: string; enabled: boolean; blocked?: string }
  | { type: 'mcp'; id: string; server: string; enabled: boolean; blocked?: string }

type Row = {
  key: string
  kind: RowKind
  client: Client
  scope: Scope
  name: string
  detail?: string
  /** The file the item itself lives in. */
  file: string
  state: string
  /** The file that decides `state`, when something overrides the default. */
  stateSource?: string
  control?: Control
}

type InventoryTabProps = {
  resource: Resource<Inventory>
  onChanged: () => void
}

export function InventoryTab({ resource, onChanged }: InventoryTabProps) {
  const action = useAction(onChanged)
  const [query, setQuery] = useState('')
  const [client, setClient] = useState('all')
  const [kind, setKind] = useState('all')
  const [scope, setScope] = useState('all')

  const inventory = resource.data
  const rows = useMemo(() => (inventory ? buildRows(inventory) : []), [inventory])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (client !== 'all' && row.client !== client) {
        return false
      }
      if (kind !== 'all' && row.kind !== kind) {
        return false
      }
      if (scope !== 'all' && row.scope !== scope) {
        return false
      }
      if (!needle) {
        return true
      }
      return (
        row.name.toLowerCase().includes(needle) ||
        row.file.toLowerCase().includes(needle) ||
        (row.detail ?? '').toLowerCase().includes(needle)
      )
    })
  }, [rows, query, client, kind, scope])

  if (!inventory) {
    if (resource.error) {
      return <FetchError message={resource.error} onRetry={resource.reload} />
    }
    return <Loading label="scanning your Claude, Codex and Cursor configuration" />
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {resource.error ? <FetchError message={resource.error} onRetry={resource.reload} /> : null}
      {action.feedback ? (
        <ActionNotice feedback={action.feedback} onDismiss={action.dismiss} />
      ) : null}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Everything Yard found</CardTitle>
          <CardDescription>
            {visible.length} of {rows.length} items · scanned from{' '}
            <span className="font-mono">{inventory.projectRoot}</span> and your home directory.
            Changing a control writes to the file named beside it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              type="search"
              placeholder="Filter by name or path"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger>
                <SelectValue placeholder="All kinds" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {ROW_KINDS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={client} onValueChange={setClient}>
              <SelectTrigger>
                <SelectValue placeholder="All clients" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All clients</SelectItem>
                {CLIENTS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger>
                <SelectValue placeholder="All scopes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All scopes</SelectItem>
                {SCOPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <TableFrame height="max-h-[34rem]">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Source file</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Decided by</TableHead>
                  <TableHead className="sticky right-0 bg-card text-right">Control</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-muted-foreground">
                      {rows.length === 0
                        ? 'No skills, plugins, MCP servers, hooks, subagents, commands or memory files were found for Claude, Codex or Cursor.'
                        : 'Nothing matches those filters.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell>
                        <Badge variant="outline">{row.kind}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.client}</TableCell>
                      <TableCell className="text-muted-foreground">{row.scope}</TableCell>
                      <TableCell className="max-w-[18rem]">
                        <span className="block truncate font-medium" title={row.name}>
                          {row.name}
                        </span>
                        {row.detail ? (
                          <span
                            className="block truncate text-xs text-muted-foreground"
                            title={row.detail}
                          >
                            {row.detail}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-[16rem] truncate">
                        {row.file ? <FilePath file={row.file} /> : <Dash />}
                      </TableCell>
                      <TableCell>{row.state}</TableCell>
                      <TableCell className="max-w-[14rem] truncate">
                        {row.stateSource ? (
                          <FilePath file={row.stateSource} />
                        ) : (
                          <span
                            className="text-xs text-muted-foreground"
                            title="nothing overrides it, so the client default applies"
                          >
                            client default
                          </span>
                        )}
                      </TableCell>
                      {/* The control is the point of the table, so it stays
                          reachable however far the row is scrolled. */}
                      <TableCell className="sticky right-0 bg-card text-right">
                        <RowControl row={row} action={action} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableFrame>
        </CardContent>
      </Card>

      {inventory.warnings.length ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Files the scan could not read</CardTitle>
            <CardDescription>
              Your clients ignore these too, silently. Doctor lists them with remedies.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {inventory.warnings.map((warning) => (
              <div key={`${warning.client}:${warning.file}:${warning.message}`}>
                <p className="text-sm">
                  {warning.client}: {warning.message}
                </p>
                <FilePath file={warning.file} full />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function Dash() {
  return <span className="text-xs text-muted-foreground">—</span>
}

function RowControl({
  row,
  action,
}: {
  row: Row
  action: ReturnType<typeof useAction>
}) {
  const control = row.control
  if (!control) {
    return <Dash />
  }
  const busy = action.pending === row.key

  if (control.type === 'skill') {
    return (
      <div className="flex items-center justify-end gap-2" title={control.blocked}>
        {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
        <Select
          value={control.visibility}
          disabled={busy || Boolean(control.blocked)}
          onValueChange={(next) => {
            action.run(row.key, () =>
              setSkillVisibility({
                id: control.id,
                skill: control.skill,
                visibility: next as SkillVisibility,
                client: row.client,
              })
            )
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SKILL_VISIBILITIES.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  const enabled = control.enabled
  return (
    <div className="flex items-center justify-end gap-2" title={control.blocked}>
      {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      <Switch
        checked={enabled}
        disabled={busy || Boolean(control.blocked)}
        aria-label={`${control.type === 'plugin' ? control.plugin : control.server} enabled`}
        onCheckedChange={(next) => {
          action.run(row.key, () =>
            control.type === 'plugin'
              ? setPluginEnabled({ id: control.id, plugin: control.plugin, enabled: next, client: row.client })
              : setMcpEnabled({ id: control.id, server: control.server, enabled: next, client: row.client })
          )
        }}
      />
    </div>
  )
}

function buildRows(inventory: Inventory): Row[] {
  const rows: Row[] = []

  for (const skill of inventory.skills) {
    rows.push({
      key: `skill:${skill.id}`,
      kind: 'skill',
      client: skill.client,
      scope: skill.scope,
      name: skill.qualifiedName,
      ...(skill.description ? { detail: skill.description } : {}),
      file: skill.file,
      state: skill.visibility,
      ...(skill.visibilitySource ? { stateSource: skill.visibilitySource } : {}),
      control: {
        type: 'skill',
        id: skill.id,
        skill: skill.qualifiedName,
        visibility: skill.visibility,
        ...(skillActionBlocked(skill) ? { blocked: skillActionBlocked(skill) } : {}),
      },
    })
  }

  for (const plugin of inventory.plugins) {
    rows.push({
      key: `plugin:${plugin.id}`,
      kind: 'plugin',
      client: plugin.client,
      scope: plugin.scope,
      name: plugin.qualifiedName,
      detail: `${plugin.version} · ${plugin.skills} skills, ${plugin.hooks} hooks, ${plugin.mcpServers} mcp${
        plugin.installed ? '' : ' · not on disk'
      }`,
      file: plugin.root ?? plugin.enabledSource ?? '',
      state: plugin.enabled ? 'enabled' : 'disabled',
      ...(plugin.enabledSource ? { stateSource: plugin.enabledSource } : {}),
      control: {
        type: 'plugin',
        id: plugin.id,
        plugin: plugin.qualifiedName,
        enabled: plugin.enabled,
        ...(pluginActionBlocked(plugin) ? { blocked: pluginActionBlocked(plugin) } : {}),
      },
    })
  }

  for (const server of inventory.mcpServers) {
    rows.push({
      key: `mcp:${server.id}`,
      kind: 'mcp',
      client: server.client,
      scope: server.scope,
      name: server.name,
      detail: server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' '),
      file: server.file,
      state: server.enabled ? 'enabled' : 'disabled',
      ...(server.enabledSource ? { stateSource: server.enabledSource } : {}),
      control: {
        type: 'mcp',
        id: server.id,
        server: server.name,
        enabled: server.enabled,
        ...(mcpActionBlocked(server) ? { blocked: mcpActionBlocked(server) } : {}),
      },
    })
  }

  for (const hook of inventory.hooks) {
    rows.push({
      key: `hook:${hook.id}`,
      kind: 'hook',
      client: hook.client,
      scope: hook.scope,
      name: hook.matcher ? `${hook.event} (${hook.matcher})` : hook.event,
      detail: hook.command,
      file: hook.file,
      state: hook.enabled ? 'enabled' : 'disabled',
      ...(hook.enabledSource ? { stateSource: hook.enabledSource } : {}),
    })
  }

  for (const agent of inventory.agents) {
    rows.push({
      key: `agent:${agent.id}`,
      kind: 'agent',
      client: agent.client,
      scope: agent.scope,
      name: agent.name,
      ...(agent.description ? { detail: agent.description } : {}),
      file: agent.file,
      state: 'loaded',
    })
  }

  for (const command of inventory.commands) {
    rows.push({
      key: `command:${command.id}`,
      kind: 'command',
      client: command.client,
      scope: command.scope,
      name: command.name,
      ...(command.description ? { detail: command.description } : {}),
      file: command.file,
      state: 'loaded',
    })
  }

  for (const memory of inventory.memory) {
    rows.push({
      key: `memory:${memory.id}`,
      kind: 'memory',
      client: memory.client,
      scope: memory.scope,
      name: memory.name,
      detail: `${formatBytes(memory.bytes)}, loaded in full`,
      file: memory.file,
      state: 'always on',
    })
  }

  return rows
}
