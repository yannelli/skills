import { useMemo } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, Stethoscope } from 'lucide-react'
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
import { Separator } from '@/components/ui/separator'
import { FetchError, FilePath, Loading } from '@/components/env/shared'
import type { Diagnosis, Severity } from '@/lib/api'
import type { Resource } from '@/lib/use-resource'

const SEVERITIES: Severity[] = ['error', 'warning', 'info']

const HEADING: Record<Severity, string> = {
  error: 'Broken',
  warning: 'Suspect',
  info: 'Worth knowing',
}

const BLURB: Record<Severity, string> = {
  error: 'these fail silently during a session',
  warning: 'these work, but not the way you think',
  info: 'nothing is broken, but there is something to tidy',
}

type DoctorTabProps = {
  resource: Resource<{ diagnoses: Diagnosis[] }>
  probe: boolean
  onProbe: () => void
}

export function DoctorTab({ resource, probe, onProbe }: DoctorTabProps) {
  const diagnoses = resource.data?.diagnoses

  const grouped = useMemo(() => {
    const groups: Record<Severity, Diagnosis[]> = { error: [], warning: [], info: [] }
    for (const diagnosis of diagnoses ?? []) {
      groups[diagnosis.severity].push(diagnosis)
    }
    return groups
  }, [diagnoses])

  if (!diagnoses) {
    if (resource.error) {
      return <FetchError message={resource.error} onRetry={resource.reload} />
    }
    return <Loading label="checking your configuration for things that fail quietly" />
  }

  const checking = probe && resource.loading

  return (
    <div className="flex flex-col gap-4">
      {resource.error ? <FetchError message={resource.error} onRetry={resource.reload} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Doctor</CardTitle>
          <CardDescription>
            {diagnoses.length
              ? `${diagnoses.length} finding${diagnoses.length === 1 ? '' : 's'} across your installed clients.`
              : 'A full pass over your installed clients.'}
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={checking}
              onClick={onProbe}
            >
              {checking ? <Loader2 className="animate-spin" /> : <Stethoscope />}
              {checking ? 'starting servers…' : 'Start MCP servers to test them'}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {probe
              ? 'Each stdio MCP server was started to check that it actually runs.'
              : 'MCP servers have not been started, so a server that exits on startup will not show up here yet. Testing them runs the same commands your client runs.'}
          </p>
        </CardContent>
      </Card>

      {diagnoses.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <CheckCircle2 className="size-8 text-muted-foreground" />
            <p className="font-heading text-base">nothing wrong</p>
            <p className="max-w-md text-sm text-muted-foreground">
              No missing hook scripts, no unreadable config, no skills the model cannot see, no
              plugins that are enabled but absent.
            </p>
          </CardContent>
        </Card>
      ) : (
        SEVERITIES.filter((severity) => grouped[severity].length).map((severity) => (
          <Card key={severity}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <SeverityIcon severity={severity} />
                {HEADING[severity]}
                <Badge variant="outline">{grouped[severity].length}</Badge>
              </CardTitle>
              <CardDescription>{BLURB[severity]}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {grouped[severity].map((diagnosis, index) => (
                <div key={`${diagnosis.code}:${index}`} className="flex flex-col gap-1">
                  {index === 0 ? null : <Separator className="mb-2" />}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{diagnosis.client}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {diagnosis.code}
                    </span>
                  </div>
                  <p className="text-sm">{diagnosis.summary}</p>
                  {diagnosis.file ? <FilePath file={diagnosis.file} full /> : null}
                  {diagnosis.remedy ? (
                    <p className="text-sm text-muted-foreground">
                      <span className="text-foreground">fix:</span> {diagnosis.remedy}
                    </p>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}

function SeverityIcon({ severity }: { severity: Severity }) {
  if (severity === 'error') {
    return <AlertCircle className="size-4 text-destructive" />
  }
  if (severity === 'warning') {
    return <AlertTriangle className="size-4 text-muted-foreground" />
  }
  return <Info className="size-4 text-muted-foreground" />
}
