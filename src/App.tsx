import { Navigate, Route, Routes } from 'react-router-dom'
import { Account } from './pages/Account'
import { Chat } from './pages/Chat'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Chat />} />
      <Route path="/account" element={<Account />} />
      <Route path="/chat" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
