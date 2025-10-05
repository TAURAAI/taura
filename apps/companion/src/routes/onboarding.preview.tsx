import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useAuthContext } from '../state/AuthContext'
import { OnboardingLayout } from '../ui/OnboardingLayout'
import Aurora from '../components/backgrounds/Aurora'
import ImageTrail from '../components/ImageTrail'
import { invoke } from '@tauri-apps/api/core'
import { readFile } from '@tauri-apps/plugin-fs'
import { useEffect, useState } from 'react'

interface ScanItem { path: string; modality: string; size: number; modified?: string | null }

function isImage(path: string, modality?: string) {
  // Only include formats the webview can display as CSS backgrounds.
  const lower = path.toLowerCase()
  return /(\.jpg|\.jpeg|\.png|\.gif|\.webp|\.bmp)$/.test(lower)
}

// prefer core.convertFileSrc; fallback handled by API

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
        // Read a subset and convert to data URLs to avoid local-scheme restrictions
        const pick = shuffled.slice(0, 36)
        const dataUrls: string[] = []
        for (const p of pick) {
          try {
            const bytes = await readFile(p)
            const mime = p.toLowerCase().endsWith('.png') ? 'image/png' : p.toLowerCase().endsWith('.webp') ? 'image/webp' : p.toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/jpeg'
            // Convert Uint8Array to base64
            let binary = ''
            const chunk = 0x8000
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode(...bytes.slice(i, i + chunk))
            }
            const b64 = btoa(binary)
            dataUrls.push(`data:${mime};base64,${b64}`)
          } catch {
            // ignore file read failures
          }
        }
        setSamples(dataUrls)
      } catch (e) {
        if (!cancelled) setSamples([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  function finish() {
    navigate({ to: '/', replace: true })
  }

  return (
    <OnboardingLayout
      title="Your recall cockpit"
      subtitle="Move your cursor to feel instant visual recall. Then launch the overlay and start typing."
      steps={[]}
      background={<Aurora speed={0.9} amplitude={1.0} blend={0.5} />}
    >
      <div className="relative w-full h-[72vh] md:h-[80vh] rounded-2xl overflow-hidden bg-white/5 border border-white/10">
        {/* Visual recall stage */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">Scanning preview…</div>
        )}
        {!loading && samples.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-white/70 p-6 text-center">
            <p>No images detected in the selected folder.</p>
            <button className="btn-outline px-3 py-1 text-xs" onClick={() => navigate({ to: '/onboarding/permissions' })}>Pick another folder</button>
          </div>
        )}
        {samples.length > 0 && (
          <>
            <ImageTrail items={samples} variant={8} sizePx={150} />
            {/* cinematic vignettes + copy overlay */}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-black/10" />
            <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(800px 280px at 50% 10%, rgba(0,0,0,0.22), transparent 60%)' }} />
            <div className="pointer-events-none absolute left-0 right-0 top-0 p-6 md:p-10 text-center">
              <h2 className="text-2xl md:text-4xl font-semibold tracking-tight">Move your cursor, feel instant recall</h2>
              <p className="mt-2 text-white/70 max-w-2xl mx-auto">Then press Cmd/Ctrl+Shift+K anywhere and just start typing.</p>
            </div>
            <div className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2 text-center px-6">
              <p className="text-white/70 text-sm md:text-base">Your own photos shimmer into view as you explore.</p>
            </div>
          </>
        )}
        {rootShown && (
          <div className="absolute top-2 left-2 text-[10px] px-2 py-1 rounded bg-black/40 text-white/60 font-mono max-w-[75%] truncate" title={rootShown}>{rootShown}</div>
        )}

        {/* CTA bar — lifted above the edge for better visibility */}
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-center pointer-events-none z-[1000]">
          <div className="pointer-events-auto mb-6 md:mb-8 inline-flex flex-wrap items-center justify-center gap-3 md:gap-4 px-4 md:px-5 py-3 md:py-4 rounded-xl border border-white/15 bg-black/45 backdrop-blur-md shadow-[0_12px_50px_-20px_rgba(0,0,0,0.7)]">
            <button onClick={() => navigate({ to: '/onboarding/permissions' })} className="btn-outline">Pick another folder</button>
            <button onClick={finish} className="btn-primary">Enter App</button>
            <span className="text-[11px] md:text-xs text-white/70">Change anytime in Settings</span>
          </div>
        </div>
      </div>
    </OnboardingLayout>
  )
}
