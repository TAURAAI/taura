import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useAuthContext } from '../state/AuthContext'
import { GoogleSignInButton } from '../ui/GoogleSignInButton'
import ScrollImageSequence from '../components/ScrollImageSequence'
import Aurora from '../components/backgrounds/Aurora'

export const Route = createFileRoute('/onboarding/welcome')({
  component: Welcome
})

function Welcome() {
  const { session } = useAuthContext()
  const navigate = useNavigate()
  if (session) {
    navigate({ to: '/onboarding/permissions', replace: true })
  }

  return (
    <div className="min-h-screen w-full text-white relative">
      {/* Full-viewport, pinned scroll-driven image sequence that fades overlay text in and then fades out */}
      <ScrollImageSequence
        className="z-10"
        frames={280}
        scrollLengthPx={3500}
        backgroundNode={<Aurora speed={0.8} amplitude={1.0} blend={0.5} />}
        startOverlay={
          <div className="text-center px-6 flex flex-col items-center gap-10">
            <h1 className="text-3xl md:text-5xl font-semibold tracking-tight drop-shadow">Welcome to Taura</h1>
            <div className="flex flex-col items-center mt-4 select-none">
              {/* <span className="text-sm md:text-base text-white/70 mb-2 tracking-wide">Scroll to continue</span>
              <div
                aria-hidden="true"
                className="w-6 h-10 rounded-full border-2 border-white/40 flex items-start justify-center relative overflow-hidden" style={{ boxShadow: '0 0 0 1px rgba(255,255,255,0.15), 0 0 12px -2px rgba(255,255,255,0.25)' }}>
                <div className="w-2 h-2 rounded-full bg-white/80 mt-2 animate-[scrollDot_1.8s_ease-in-out_infinite]" />
              </div> */}
              <svg className="mt-4 w-6 h-6 text-white/70 animate-bounce" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>
          </div>
        }
        startDisappearAt={0.08}
        endOverlay={
          <div className="text-center px-6">
            <h1 className="text-3xl md:text-5xl font-semibold tracking-tight drop-shadow">Personal, powerful semantic memory</h1>
            <p className="mt-3 text-white/80 max-w-2xl mx-auto">Fast, private recall across your images and documents.</p>
            <div className="mt-6 max-w-3xl mx-auto text-center space-y-3">
              <p className="text-white/70 max-w-2xl mx-auto">Sign in to tie your encrypted local index to your account.</p>
              <div className="w-full max-w-sm mx-auto flex flex-col items-center gap-4">
                <GoogleSignInButton />
              </div>
            </div>
          </div>
        }
        endAppearAt={0.85}
      />
    </div>
  )
}
