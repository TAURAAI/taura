import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useAuthContext } from '../state/AuthContext'
import { OnboardingLayout } from '../ui/OnboardingLayout'
import Aurora from '../components/backgrounds/Aurora'
import ImageTrail from '../components/ImageTrail'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'

interface ScanItem { path: string; modality: string; size: number; modified?: string | null }

function isImage(path: string, modality?: string) {
  if (modality && modality.startsWith('image')) return true
  const lower = path.toLowerCase()
  return /(\.jpg|\.jpeg|\.png|\.gif|\.webp|\.bmp|\.tiff|\.tif|\.heic|\.heif)$/.test(lower)
}

export const Route = createFileRoute('/onboarding/preview')({
  component: PreviewStep
})

function PreviewStep() {
  const { session } = useAuthContext()
  const navigate = useNavigate()
  if (!session) throw redirect({ to: '/onboarding/welcome' })
  const [samples, setSamples] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [rootShown, setRootShown] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const root = localStorage.getItem('taura.root')
        setRootShown(root)
        if (!root) { setSamples([]); setLoading(false); return }
        // Use scan_folder to fetch a pool of candidates (does not persist index). Limit for speed.
        const res: any = await invoke('scan_folder', { path: root, maxSamples: 200, throttleMs: 0 })
        if (cancelled) return
        const items: ScanItem[] = Array.isArray(res?.items) ? res.items : []
        const images = items.filter(it => isImage(it.path, it.modality)).map(i => i.path)
        const shuffled = images.sort(() => Math.random() - 0.5)
        // Provide enough for animation variety
        setSamples(shuffled.slice(0, 40).map(p => `file://${p}`))
      } catch (e) {
        if (!cancelled) setSamples([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const steps = [
    { id: 'welcome', label: 'Account' },
    { id: 'permissions', label: 'Folder & Mode' },
    { id: 'preview', label: 'Preview' },
  ]

  function finish() {
    navigate({ to: '/', replace: true })
  }

  return (
    <OnboardingLayout
      title="Your recall cockpit"
      subtitle="Move your cursor to sample how instant visual recall feels. Then launch the overlay and start typing."
      steps={steps}
      currentStepId="preview"
      background={<Aurora speed={0.9} amplitude={1.0} blend={0.5} />}
      onStepClick={(id) => {
        if (id === 'permissions') navigate({ to: '/onboarding/permissions' })
        if (id === 'welcome') navigate({ to: '/onboarding/welcome' })
      }}
    >
      <div className="w-full flex flex-col md:flex-row gap-10 items-stretch">
        <div className="relative flex-1 min-h-[380px] rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-white/50">Scanning preview…</div>
          )}
          {!loading && samples.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-white/50 p-6 text-center">
              <p>No images detected in selected folder.</p>
              <button className="btn-outline px-3 py-1 text-xs" onClick={() => navigate({ to: '/onboarding/permissions' })}>Pick another folder</button>
            </div>
          )}
          {samples.length > 0 && <ImageTrail items={samples} variant={7} />}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#0c0e10] to-transparent" />
          {rootShown && (
            <div className="absolute top-2 left-2 text-[10px] px-2 py-1 rounded bg-black/40 text-white/60 font-mono max-w-[75%] truncate" title={rootShown}>{rootShown}</div>
          )}
        </div>
        <div className="w-full max-w-sm flex flex-col gap-5">
          <ul className="space-y-3 text-sm text-white/70">
            <li className="flex gap-3"><span className="h-5 w-5 flex items-center justify-center rounded bg-blue-600/70 text-[11px] font-semibold">1</span><span>Invoke overlay (Cmd/Ctrl+Shift+K) while typing anywhere.</span></li>
            <li className="flex gap-3"><span className="h-5 w-5 flex items-center justify-center rounded bg-blue-600/70 text-[11px] font-semibold">2</span><span>Describe the memory: "passport renewal june 2022".</span></li>
            <li className="flex gap-3"><span className="h-5 w-5 flex items-center justify-center rounded bg-blue-600/70 text-[11px] font-semibold">3</span><span>Results stream in under 150ms on average.</span></li>
            <li className="flex gap-3"><span className="h-5 w-5 flex items-center justify-center rounded bg-blue-600/70 text-[11px] font-semibold">4</span><span>Tap a result to open it instantly.</span></li>
          </ul>
          <div className="flex gap-3 pt-2">
            <button onClick={() => navigate({ to: '/onboarding/permissions' })} className="btn-outline flex-1">Back</button>
            <button onClick={finish} className="btn-primary flex-1">Enter App</button>
          </div>
          <p className="text-[11px] text-white/50">You can revisit these settings anytime under Settings.</p>
        </div>
      </div>
    </OnboardingLayout>
  )
}
