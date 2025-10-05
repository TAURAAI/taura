import type { ReactNode } from 'react'

interface StepMeta { id: string; label: string }

interface LayoutProps {
  title: string
  subtitle?: string
  children: ReactNode
  steps?: StepMeta[]
  currentStepId?: string
  onStepClick?: (id: string) => void
  background?: ReactNode
}

export function OnboardingLayout({ title, subtitle, children, steps = [], currentStepId, onStepClick, background }: LayoutProps) {
  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center px-6 py-10 relative overflow-hidden font-sans text-white">
      {background && <div className="absolute inset-0 -z-10 opacity-70">{background}</div>}
      <div className="relative z-10 w-full max-w-5xl mx-auto flex flex-col gap-10">
        {steps.length > 0 && (
          <nav aria-label="Onboarding progress" className="flex flex-wrap gap-3 justify-center">
            {steps.map((s, i) => {
              const active = s.id === currentStepId
              const doneIndex = steps.findIndex(st => st.id === currentStepId)
              const done = doneIndex > i && doneIndex !== -1
              return (
                <button
                  key={s.id}
                  onClick={() => onStepClick && onStepClick(s.id)}
                  className={`group flex items-center gap-2 px-4 py-2 rounded-full text-xs tracking-wide font-medium transition border ${active ? 'bg-white/15 border-white/40 text-white shadow-[0_0_0_1px_rgba(255,255,255,0.3)]' : done ? 'bg-white/8 border-white/25 text-white/80 hover:bg-white/12' : 'bg-white/5 border-white/15 text-white/55 hover:text-white/80 hover:bg-white/10'}`}
                >
                  <span className={`h-5 w-5 rounded-full flex items-center justify-center text-[11px] font-semibold ${active ? 'bg-blue-500 text-white' : done ? 'bg-blue-600/70 text-white' : 'bg-white/15 text-white/70 group-hover:text-white'}`}>{done ? '✓' : i + 1}</span>
                  <span>{s.label}</span>
                </button>
              )
            })}
          </nav>
        )}
        <header className="text-center space-y-4">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight leading-tight">
            {title}
          </h1>
          {subtitle && <p className="text-sm md:text-base text-white/65 max-w-2xl mx-auto leading-relaxed">{subtitle}</p>}
        </header>
        <div className="flex flex-col md:flex-row md:items-start gap-10 w-full">
          <div className="flex-1 flex flex-col items-center md:items-start gap-6 w-full">{children}</div>
        </div>
      </div>
    </div>
  )
}
