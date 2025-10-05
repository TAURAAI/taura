import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useAuthContext } from '../state/AuthContext'
import { useAppConfig, updateConfig } from '../state/config'
import { OnboardingLayout } from '../ui/OnboardingLayout'
import Prism from '../components/backgrounds/Prism'

export const Route = createFileRoute('/onboarding/permissions')({
  component: Permissions
})

function Permissions() {
  const { session } = useAuthContext()
  const cfg = useAppConfig()
  const navigate = useNavigate()
  if (!session) throw redirect({ to: '/onboarding/welcome' })
  const [root, setRoot] = useState<string>('')
  const [picked, setPicked] = useState(false)
  const [mode, setMode] = useState(cfg.privacyMode)

  async function pick() {
    try {
      const res = await invoke<string | null>('pick_folder')
      if (res) { setRoot(res); setPicked(true) }
    } catch {}
  }

  function apply() {
    if (mode !== cfg.privacyMode) updateConfig({ privacyMode: mode })
    // root path persisted via config for now (extend config schema) or emitted to indexer
    // TODO: integrate with indexer root path persistence
    navigate({ to: '/onboarding/preview', replace: true })
  }

  const steps = [
    { id: 'welcome', label: 'Account' },
    { id: 'permissions', label: 'Folder & Mode' },
    { id: 'preview', label: 'Preview' },
  ]

  return (
    <OnboardingLayout
      title="Set up your local library"
      subtitle="Pick a root folder (can add more later) and choose a privacy mode."
      steps={steps}
      currentStepId="permissions"
      background={<Prism animationType='hover' timeScale={0.15} hueShift={0} bloom={0.4} />}
      onStepClick={(id) => {
        if (id === 'welcome') navigate({ to: '/onboarding/welcome' })
      }}
    >
      <div className="space-y-4 w-full max-w-md">
        <button onClick={pick} className="w-full rounded border border-white/15 px-4 py-3 text-left hover:border-white/30 transition text-sm backdrop-blur bg-white/5">
          {picked ? (<><span className="font-medium">{root}</span></>) : 'Pick a root folder'}
        </button>
        <fieldset className="w-full rounded border border-white/15 p-4 flex flex-col gap-3 bg-white/5">
          <legend className="text-xs uppercase tracking-wide text-white/50 px-1">Privacy Mode</legend>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="radio" name="mode" value="strict-local" checked={mode==='strict-local'} onChange={()=>setMode('strict-local')} />
            <span className="text-sm"><span className="font-medium">Strict-Local</span><br/><span className="text-white/50">No images leave device. Slower if no GPU local.</span></span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="radio" name="mode" value="hybrid" checked={mode==='hybrid'} onChange={()=>setMode('hybrid')} />
            <span className="text-sm"><span className="font-medium">Hybrid</span><br/><span className="text-white/50">Send low-res images for embedding, faster recall.</span></span>
          </label>
        </fieldset>
        <div className="flex gap-3 pt-2">
          <button onClick={() => navigate({ to: '/onboarding/welcome' })} className="btn-outline flex-1">Back</button>
          <button disabled={!picked} onClick={apply} className="btn-primary flex-1 disabled:opacity-40 disabled:cursor-not-allowed">Continue</button>
        </div>
      </div>
    </OnboardingLayout>
  )
}
