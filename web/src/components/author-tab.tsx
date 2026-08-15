import { useCallback, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Textarea } from '@/components/ui/textarea'
import { TableFrame } from '@/components/env/shared'
import {
  ARTIFACT_KINDS,
  api,
  type AdaptReport,
  type ArtifactRecord,
  type CatalogResponse,
} from '@/lib/api'
import { messageOf } from '@/lib/format'
import { useResource } from '@/lib/use-resource'

/**
 * Authoring this repository's own plugins, which is a different job from the
 * rest of Yard: everything here writes into the marketplace in this checkout,
 * never into the developer's installed clients.
 */
export function AuthorTab() {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<ArtifactRecord | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pluginName, setPluginName] = useState('')
  const [pluginDescription, setPluginDescription] = useState('')
  const [adaptSource, setAdaptSource] = useState('')
  const [adaptName, setAdaptName] = useState('')
  const [adaptRegister, setAdaptRegister] = useState(true)

  const loadCatalog = useCallback(() => {
    const params = new URLSearchParams()
    if (query) {
      params.set('q', query)
    }
    if (kind !== 'all') {
      params.set('kind', kind)
    }
    return api<CatalogResponse>(`/api/catalog?${params}`)
  }, [kind, query])

  const resource = useResource(loadCatalog, 'the catalog could not be loaded')
  const { reload: refresh } = resource
  const catalog: CatalogResponse = resource.data ?? { plugins: [], artifacts: [] }
  const loading = resource.loading

  const select = useCallback((id: string) => {
    setSelected(id)
    api<{ artifact: ArtifactRecord }>(`/api/artifact?id=${encodeURIComponent(id)}`).then(
      (data) => {
        setArtifact(data.artifact)
        setDraft(data.artifact.raw)
        setError(null)
      },
      (err: unknown) => {
        setError(messageOf(err, 'that artifact could not be opened'))
      }
    )
  }, [])

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {error ?? resource.error ? (
        <Alert variant="destructive">
          <AlertTitle>the last call to this repository failed</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{error ?? resource.error}</span>
            <Button type="button" variant="outline" size="xs" onClick={refresh}>
              try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {status ? (
        <Alert>
          <AlertTitle>{status}</AlertTitle>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
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
                    setError(null)
                    return refresh()
                  })
                  .catch((err: unknown) => {
                    setError(messageOf(err, 'the plugin could not be scaffolded'))
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

        <Card size="sm">
          <CardHeader>
            <CardTitle>Adapt</CardTitle>
            <CardDescription>
              Turn a Claude-only skill or plugin into Codex, Cursor, and Agent Plugins files.
              Existing files stay.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void api<AdaptReport>('/api/adapt', {
                  method: 'POST',
                  body: JSON.stringify({
                    source: adaptSource,
                    ...(adaptName ? { name: adaptName } : {}),
                    register: adaptRegister,
                  }),
                })
                  .then((report) => {
                    setAdaptSource('')
                    setAdaptName('')
                    setError(null)
                    setStatus(
                      report.registered
                        ? `Adapted ${report.name} and registered it`
                        : `Adapted ${report.name}` +
                            (report.wrote.length ? ` · wrote ${report.wrote.length}` : '')
                    )
                    return refresh()
                  })
                  .catch((err: unknown) => {
                    setError(messageOf(err, 'the source could not be adapted'))
                  })
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="adapt-source">Source</Label>
                <Input
                  id="adapt-source"
                  required
                  placeholder="path/to/SKILL.md or a Claude plugin"
                  value={adaptSource}
                  onChange={(event) => setAdaptSource(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="adapt-name">Name</Label>
                <Input
                  id="adapt-name"
                  pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                  placeholder="optional kebab-case override"
                  value={adaptName}
                  onChange={(event) => setAdaptName(event.target.value)}
                />
              </div>
              <label className="flex items-center gap-3">
                <Switch checked={adaptRegister} onCheckedChange={setAdaptRegister} />
                <span className="text-sm">Add to catalogs</span>
              </label>
              <Button type="submit">Adapt</Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Catalog</CardTitle>
            <CardDescription>
              {catalog.plugins.length} plugins · {catalog.artifacts.length} artifacts in this
              checkout
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="search"
                placeholder="Search the yard"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="sm:w-40">
                  <SelectValue placeholder="All kinds" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All kinds</SelectItem>
                  {ARTIFACT_KINDS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <TableFrame>
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>Id</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {catalog.artifacts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-muted-foreground">
                        {loading ? 'Loading the catalog…' : 'No artifacts match.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    catalog.artifacts.map((item) => (
                      <TableRow
                        key={item.id}
                        data-state={selected === item.id ? 'selected' : undefined}
                        className="cursor-pointer"
                        onClick={() => select(item.id)}
                      >
                        <TableCell className="font-mono text-xs">{item.id}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{item.kind}</Badge>
                        </TableCell>
                        <TableCell className="max-w-md truncate text-muted-foreground">
                          {item.description}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableFrame>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="font-mono text-sm break-all">
              {artifact?.id ?? 'Select an artifact'}
            </CardTitle>
            <CardDescription>
              {artifact?.description || 'Pick a row to edit its source.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
            <Label htmlFor="editor">Body</Label>
            <Textarea
              id="editor"
              className="min-h-64 flex-1 font-mono text-xs"
              spellCheck={false}
              disabled={!artifact}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              type="button"
              className="self-start"
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
                    setStatus(`Saved ${data.artifact.path}`)
                    setError(null)
                    return refresh()
                  })
                  .catch((err: unknown) => {
                    setError(messageOf(err, 'the file could not be saved'))
                  })
              }}
            >
              Save
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
