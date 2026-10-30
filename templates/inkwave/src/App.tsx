import { Route, Routes } from 'react-router'
import GamePage from '@/pages/GamePage'
import GuidePage from '@/pages/GuidePage'

export function App() {
  return (
    <Routes>
      <Route path="/guide" element={<GuidePage />} />
      <Route path="*" element={<GamePage />} />
    </Routes>
  )
}
