import { useCallback, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AuthorTab } from '@/components/author-tab'
import { ContextTab } from '@/components/env/context-tab'
import { DoctorTab } from '@/components/env/doctor-tab'
import { InventoryTab } from '@/components/env/inventory-tab'
import { fetchContext, fetchDoctor, fetchInventory } from '@/lib/api'
import { formatTokens } from '@/lib/format'
import { useResource } from '@/lib/use-resource'

export function App() {
  // Probing starts the developer's own MCP servers, so it stays false until a
  // button says otherwise, and it resets on every reload of the page.
  const [contextProbe, setContextProbe] = useState(false)
  const [doctorProbe, setDoctorProbe] = useState(false)

  const loadInventory = useCallback(() => fetchInventory(), [])
  const loadContext = useCallback(() => fetchContext(contextProbe), [contextProbe])
  const loadDoctor = useCallback(() => fetchDoctor(doctorProbe), [doctorProbe])

  const inventory = useResource(loadInventory, 'the scan failed')
  const context = useResource(loadContext, 'the context report failed')
  const doctor = useResource(loadDoctor, 'the diagnosis failed')

  const { reload: reloadInventory } = inventory
  const { reload: reloadContext } = context
  const { reload: reloadDoctor } = doctor

  const refreshAll = useCallback(() => {
    reloadInventory()
    reloadContext()
    reloadDoctor()
  }, [reloadInventory, reloadContext, reloadDoctor])

  const measureContext = useCallback(() => {
    if (contextProbe) {
      reloadContext()
      return
    }
    setContextProbe(true)
  }, [contextProbe, reloadContext])

  const probeDoctor = useCallback(() => {
    if (doctorProbe) {
      reloadDoctor()
      return
    }
    setDoctorProbe(true)
  }, [doctorProbe, reloadDoctor])

  const itemCount = useMemo(() => {
    const found = inventory.data
    if (!found) {
      return undefined
    }
    return (
      found.skills.length +
      found.plugins.length +
      found.mcpServers.length +
      found.hooks.length +
      found.agents.length +
      found.commands.length +
      found.memory.length
    )
  }, [inventory.data])

  const errorCount = useMemo(
    () => (doctor.data?.diagnoses ?? []).filter((item) => item.severity === 'error').length,
    [doctor.data]
  )
  const findingCount = doctor.data?.diagnoses.length

  const busy = inventory.loading || context.loading || doctor.loading

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-2">
          <h1 className="font-heading text-lg font-medium tracking-tight">Yard</h1>
          <span className="text-xs text-muted-foreground">
            what your agent clients are actually loading
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">
            {inventory.data?.clients.length
              ? inventory.data.clients.join(' · ')
              : 'no client detected'}
          </span>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={refreshAll}>
            <RefreshCw className={busy ? 'animate-spin' : undefined} />
            Rescan
          </Button>
        </div>
      </header>

      <main className="min-w-0 flex-1 p-4 sm:p-6">
        <Tabs defaultValue="context" className="min-w-0 gap-4">
          <div className="w-fit max-w-full overflow-x-auto pb-1.5">
            <TabsList>
              <TabsTrigger value="context">
                Context
                {context.data ? (
                  <Badge variant="secondary">≈{formatTokens(context.data.total)}</Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="inventory">
                Inventory
                {itemCount === undefined ? null : <Badge variant="secondary">{itemCount}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="doctor">
                Doctor
                {findingCount === undefined || findingCount === 0 ? null : (
                  <Badge variant={errorCount ? 'destructive' : 'secondary'}>{findingCount}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="author">Author</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="context" className="min-w-0">
            <ContextTab
              resource={context}
              probe={contextProbe}
              onMeasure={measureContext}
              onChanged={refreshAll}
            />
          </TabsContent>
          <TabsContent value="inventory" className="min-w-0">
            <InventoryTab resource={inventory} onChanged={refreshAll} />
          </TabsContent>
          <TabsContent value="doctor" className="min-w-0">
            <DoctorTab resource={doctor} probe={doctorProbe} onProbe={probeDoctor} />
          </TabsContent>
          <TabsContent value="author" className="min-w-0">
            <AuthorTab />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

export default App
