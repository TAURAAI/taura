import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useAuthContext } from '../state/AuthContext'
import { OnboardingLayout } from '../ui/OnboardingLayout'
import { GoogleSignInButton } from '../ui/GoogleSignInButton'
import Prism from '../components/backgrounds/Prism'

export const Route = createFileRoute('/onboarding/welcome')({
  component: Welcome
})

function Welcome() {
  const { session } = useAuthContext()
  const navigate = useNavigate()
  if (session) {
    navigate({ to: '/onboarding/permissions', replace: true })
  }
  const steps = [
    { id: 'welcome', label: 'Account' },
    { id: 'permissions', label: 'Folder & Mode' },
    { id: 'preview', label: 'Preview' },
  ]
  return (
    <OnboardingLayout
      title="Personal semantic memory."
      subtitle="Fast, private recall across your images & documents. Sign in to tie your encrypted local index to a user id."
      steps={steps}
      currentStepId="welcome"
      onStepClick={(id) => {
        if (id === 'permissions' && session) navigate({ to: '/onboarding/permissions' })
      }}
      background={<Prism animationType='3drotate' timeScale={0.25} hueShift={0} bloom={0.6} />}
    >
      <div className="w-full max-w-sm mx-auto flex flex-col items-center gap-5">
        <GoogleSignInButton />
      </div>
    </OnboardingLayout>
  )
}
