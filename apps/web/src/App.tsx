import { useEffect } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { DevicePage } from '@/pages/Device'
import { LoginPage } from '@/pages/Login'
import { RegisterPage } from '@/pages/Register'
import { SettingsPage } from '@/pages/Settings'
import { StudioPage } from '@/pages/Studio'
import { useAuth } from '@/store/auth'

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-3">
        <div className="text-2xl text-accent">◈</div>
        <div className="h-1 w-32 overflow-hidden rounded-full bg-line">
          <div className="h-full w-1/3 animate-[shimmer_1.2s_ease-in-out_infinite] bg-accent" />
        </div>
      </div>
    </div>
  )
}

function Protected({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status)
  if (status === 'loading') return <LoadingScreen />
  if (status === 'anonymous') return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap)
  const navigate = useNavigate()

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    // The API client fires this when a refresh fails, so an expired session
    // lands on the login screen instead of a wall of failed requests.
    const onSignedOut = () => navigate('/login', { replace: true })
    window.addEventListener('sv:signed-out', onSignedOut)
    return () => window.removeEventListener('sv:signed-out', onSignedOut)
  }, [navigate])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/device"
        element={
          <Protected>
            <DevicePage />
          </Protected>
        }
      />
      <Route
        path="/settings/*"
        element={
          <Protected>
            <SettingsPage />
          </Protected>
        }
      />
      <Route
        path="/"
        element={
          <Protected>
            <StudioPage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
