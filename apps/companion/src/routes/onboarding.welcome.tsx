import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useAuthContext } from '../state/AuthContext'
import { GoogleSignInButton } from '../ui/GoogleSignInButton'
import ScrollImageSequence from '../components/ScrollImageSequence'
import Aurora from '../components/backgrounds/Aurora'
// no extra hooks needed

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
        startOverlay={<div className="text-center px-6"><h1 className="text-3xl md:text-5xl font-semibold tracking-tight drop-shadow">Welcome to Taura</h1></div>}
        startDisappearAt={0.08}
        endOverlay={
          <div className="text-center px-6">
            <h1 className="text-3xl md:text-5xl font-semibold tracking-tight drop-shadow">Personal semantic memory</h1>
            <p className="mt-3 text-white/80 max-w-2xl mx-auto">Fast, private recall across your images and documents.</p>
            <div className="mt-6 max-w-3xl mx-auto text-center space-y-3">
              <p className="text-white/70 max-w-2xl mx-auto">Sign in to tie your encrypted local index to your account.</p>
              <div className="w-full max-w-sm mx-auto flex flex-col items-center gap-4">
                <GoogleSignInButton />
              </div>
            </div>
          </div>
        }
        endAppearAt={0.75}
      />
      {/* No separate section; the end overlay includes the sign-in content in the same div */}
    </div>
  )
}
