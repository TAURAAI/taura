import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useAuth } from '../state/auth'
import { OnboardingLayout } from '../ui/OnboardingLayout'
import Prism from '../components/backgrounds/Prism'
import ImageTrail from '../components/ImageTrail'

// Sample placeholder thumbnails (replace with local assets or generated thumbs later)
const SAMPLE_IMAGES = [
  'https://picsum.photos/seed/taura1/400/300',
  'https://picsum.photos/seed/taura2/400/300',
  'https://picsum.photos/seed/taura3/400/300',
  'https://picsum.photos/seed/taura4/400/300',
  'https://picsum.photos/seed/taura5/400/300',
  'https://picsum.photos/seed/taura6/400/300',
  'https://picsum.photos/seed/taura7/400/300',
  'https://picsum.photos/seed/taura8/400/300'
]

export const Route = createFileRoute('/onboarding/preview')({
  component: PreviewStep
})

function PreviewStep() {
  const { session } = useAuth()
  const navigate = useNavigate()
  if (!session) throw redirect({ to: '/onboarding/welcome' })

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
      background={<Prism animationType='3drotate' timeScale={0.2} hueShift={0} bloom={0.5} />}
      onStepClick={(id) => {
        if (id === 'permissions') navigate({ to: '/onboarding/permissions' })
        if (id === 'welcome') navigate({ to: '/onboarding/welcome' })
      }}
    >
      <div className="w-full flex flex-col md:flex-row gap-10 items-stretch">
        <div className="relative flex-1 min-h-[380px] rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
          <ImageTrail items={SAMPLE_IMAGES} variant={7} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#0c0e10] to-transparent" />
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
