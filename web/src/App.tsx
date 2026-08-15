import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ChipList } from '@/components/chip-list'
import {
  ARTIFACT_KINDS,
  api,
  postIds,
  type ArtifactRecord,
  type CatalogResponse,
  type SessionView,
} from '@/lib/api'
import { kindLabel, statusLabel, statusOf, type ArtifactStatus } from '@/lib/status'

function statusVariant(
  status: ArtifactStatus
): 'default' | 'secondary' | 'outline' | 'destructive' | 'ghost' {
  switch (status) {
    case 'pinned':
      return 'default'
    case 'hydrated':
      return 'secondary'
    case 'shelved':
      return 'outline'
    case 'off':
      return 'destructive'
    case 'open':
      return 'ghost'
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

export function App() {
  const [catalog, setCatalog] = useState<CatalogResponse>({ plugins: [], artifacts: [] })
  const [session, setSession] = useState<SessionView | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<ArtifactRecord | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pluginName, setPluginName] = useState('')
  const [pluginDescription, setPluginDescription] = useState('')

  const applySession = useCallback((next: SessionView) => {
    setSession(next)
  }, [])

  const refresh = useCallback(async () => {
    const params = new URLSearchParams()
    if (query) {
      params.set('q', query)
    }
    if (kind !== 'all') {
      params.set('kind', kind)
    }
    const [nextCatalog, nextSession] = await Promise.all([
      api<CatalogResponse>(`/api/catalog?${params}`),
      api<SessionView>('/api/session'),
    ])
    setCatalog(nextCatalog)
    setSession(nextSession)
  }, [kind, query])

  useEffect(() => {
    void refresh().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to load Yard')
    })
  }, [refresh])

  const select = useCallback(async (id: string) => {
    setSelected(id)
    const data = await api<{ artifact: ArtifactRecord }>(`/api/artifact?id=${encodeURIComponent(id)}`)
    setArtifact(data.artifact)
    setDraft(data.artifact.raw)
  }, [])

  const runIds = useCallback(
    async (path: string, ids: string[]) => {
      applySession(await postIds(path, ids))
    },
    [applySession]
  )

  const counts = useMemo(() => {
    if (!session) {
      return '—'
    }
    return `${catalog.plugins.length} plugins · ${catalog.artifacts.length} artifacts · ${session.available.length} live`
  }, [catalog, session])

  const selectedStatus = artifact ? statusOf(artifact.id, session) : null

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex flex-wrap items-center gap-4 border-b border-border px-6 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="font-heading text-lg font-medium tracking-tight">Yard</h1>
          <span className="font-mono text-xs text-muted-foreground">yannelli-skills</span>
        </div>
        <label className="flex items-center gap-3">
          <Switch
            checked={Boolean(session?.dynamicMode)}
            onCheckedChange={(enabled) => {
              void api<SessionView>('/api/session/dynamic', {
                method: 'POST',
                body: JSON.stringify({ enabled }),
              }).then(applySession)
            }}
          />
          <span className="leading-tight">
            <span className="block text-sm font-medium">Dynamic</span>
            <span className="block text-xs text-muted-foreground">search, then hydrate</span>
          </span>
        </label>
        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">{counts}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void api('/api/catalog/reload', { method: 'POST' })
                .then(() => refresh())
                .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Reload failed'))
            }}
          >
            <RefreshCw />
            Rescan
          </Button>
        </div>
      </header>

      {error ? (
        <div className="px-6 pt-4">
          <Alert variant="destructive">
            <AlertTitle>Yard could not load</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[20rem_minmax(0,1fr)_24rem]">
        <ScrollArea className="h-[calc(100svh-5.5rem)]">
          <div className="flex flex-col gap-4 pr-3">
            <Card size="sm">
              <CardHeader>
                <CardTitle>On the floor</CardTitle>
                <CardDescription>
                  {session?.dynamicMode
                    ? 'Only pinned and hydrated artifacts are in context. The rest stay searchable.'
                    : 'Dynamic is off. Every enabled artifact is available.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Pinned</h3>
                  <ChipList
                    ids={session?.pinned ?? []}
                    actionLabel="Unpin"
                    onAction={(id) => void runIds('/api/session/unpin', [id])}
                  />
                </section>
                <Separator />
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Hydrated</h3>
                  <ChipList
                    ids={session?.hydrated ?? []}
                    actionLabel="Drop"
                    onAction={(id) => void runIds('/api/session/dehydrate', [id])}
                  />
                </section>
                <Separator />
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Hooks live</h3>
                  <ChipList
                    ids={session?.hooksActive ?? []}
                    actionLabel="Cut"
                    onAction={(id) =>
                      void api<SessionView>('/api/session/hooks', {
                        method: 'POST',
                        body: JSON.stringify({ ids: [id], active: false }),
                      }).then(applySession)
                    }
                  />
                </section>
                <Separator />
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">MCP live</h3>
                  <ChipList
                    ids={session?.mcpLive ?? []}
                    actionLabel="Cut"
                    onAction={(id) =>
                      void api<SessionView>('/api/session/mcp', {
                        method: 'POST',
                        body: JSON.stringify({ ids: [id], active: false }),
                      }).then(applySession)
                    }
                  />
                </section>
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle>Plugins</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {catalog.plugins.map((plugin) => {
                  const enabled = !session?.disabledPlugins.includes(plugin.name)
                  return (
                    <div key={plugin.name} className="flex items-center justify-between gap-2">
                      <span className="text-sm">{plugin.name}</span>
                      <Button
                        type="button"
                        variant={enabled ? 'secondary' : 'outline'}
                        size="xs"
                        onClick={() =>
                          void api<SessionView>(`/api/plugins/${plugin.name}/enabled`, {
                            method: 'POST',
                            body: JSON.stringify({ enabled: !enabled }),
                          }).then(applySession)
                        }
                      >
                        {enabled ? 'On' : 'Off'}
                      </Button>
                    </div>
                  )
                })}
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle>New plugin</CardTitle>
                <CardDescription>Scaffolds manifests and catalog entries.</CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void api('/api/plugins', {
                      method: 'POST',
                      body: JSON.stringify({ name: pluginName, description: pluginDescription }),
                    })
                      .then(() => {
                        setPluginName('')
                        setPluginDescription('')
                        setStatus('Plugin scaffolded')
                        return refresh()
                      })
                      .catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : 'Scaffold failed')
                      })
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="plugin-name">Name</Label>
                    <Input
                      id="plugin-name"
                      required
                      pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                      placeholder="my-tool"
                      value={pluginName}
                      onChange={(event) => setPluginName(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="plugin-description">Description</Label>
                    <Input
                      id="plugin-description"
                      required
                      placeholder="When to use it"
                      value={pluginDescription}
                      onChange={(event) => setPluginDescription(event.target.value)}
                    />
                  </div>
                  <Button type="submit">Scaffold</Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </ScrollArea>

        <Card className="min-h-0">
          <CardHeader className="border-b">
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                type="search"
                placeholder="Search the yard"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoFocus
              />
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="sm:w-40">
                  <SelectValue placeholder="All kinds" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All kinds</SelectItem>
                  {ARTIFACT_KINDS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {kindLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Id</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalog.artifacts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
                      No artifacts match.
                    </TableCell>
                  </TableRow>
                ) : (
                  catalog.artifacts.map((item) => {
                    const rowStatus = statusOf(item.id, session)
                    return (
                      <TableRow
                        key={item.id}
                        data-state={selected === item.id ? 'selected' : undefined}
                        className="cursor-pointer"
                        onClick={() => void select(item.id)}
                      >
                        <TableCell className="font-mono text-xs">{item.id}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{kindLabel(item.kind)}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(rowStatus)}>{statusLabel(rowStatus)}</Badge>
                        </TableCell>
                        <TableCell className="max-w-md truncate text-muted-foreground">
                          {item.description}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="min-h-0">
          <CardHeader>
            <CardTitle className="font-mono text-sm break-all">
              {artifact?.id ?? 'Select an artifact'}
            </CardTitle>
            <CardDescription>
              {artifact?.description || 'Bodies stay on disk until you hydrate them in dynamic mode.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
            {artifact && selectedStatus ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void runIds(
                      selectedStatus === 'pinned' ? '/api/session/unpin' : '/api/session/pin',
                      [artifact.id]
                    )
                  }
                >
                  {selectedStatus === 'pinned' ? 'Unpin' : 'Pin'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void runIds(
                      selectedStatus === 'hydrated' ? '/api/session/dehydrate' : '/api/session/hydrate',
                      [artifact.id]
                    )
                  }
                >
                  {selectedStatus === 'hydrated' ? 'Dehydrate' : 'Hydrate'}
                </Button>
                {artifact.kind === 'hook' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void api<SessionView>('/api/session/hooks', {
                        method: 'POST',
                        body: JSON.stringify({
                          ids: [artifact.id],
                          active: !session?.hooksActive.includes(artifact.id),
                        }),
                      }).then(applySession)
                    }
                  >
                    {session?.hooksActive.includes(artifact.id) ? 'Disable hooks' : 'Enable hooks'}
                  </Button>
                ) : null}
                {artifact.kind === 'mcp' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void api<SessionView>('/api/session/mcp', {
                        method: 'POST',
                        body: JSON.stringify({
                          ids: [artifact.id],
                          active: !session?.mcpLive.includes(artifact.id),
                        }),
                      }).then(applySession)
                    }
                  >
                    {session?.mcpLive.includes(artifact.id) ? 'Disable MCP' : 'Enable MCP'}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <Label htmlFor="editor">Body</Label>
            <Textarea
              id="editor"
              className="min-h-64 flex-1 font-mono text-xs"
              spellCheck={false}
              disabled={!artifact}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="flex items-center gap-3">
              <Button
                type="button"
                disabled={!artifact}
                onClick={() => {
                  if (!artifact) {
                    return
                  }
                  void api<{ artifact: ArtifactRecord }>(
                    `/api/artifact?id=${encodeURIComponent(artifact.id)}`,
                    { method: 'PUT', body: JSON.stringify({ raw: draft }) }
                  )
                    .then((data) => {
                      setArtifact(data.artifact)
                      setDraft(data.artifact.raw)
                      setStatus('Saved')
                      return refresh()
                    })
                    .catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : 'Save failed')
                    })
                }}
              >
                Save
              </Button>
              {status ? <span className="text-xs text-muted-foreground">{status}</span> : null}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

export default App
