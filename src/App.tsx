import { Navigate, Route, Routes } from 'react-router-dom'
import { Account } from './pages/Account'
import { Image } from './pages/Image'
import { Purchase } from './pages/Purchase'
import { TextImage } from './pages/TextImage'
import { Video } from './pages/Video'
import { WanI2V } from './pages/WanI2V'
import { Voice } from './pages/Voice'

export function App() {
  return (
    <Routes>
      <Route path='/' element={<TextImage />} />
      <Route path='/image' element={<Image />} />
      <Route path='/purchase' element={<Purchase />} />
      <Route path='/anime' element={<Video />} />
      <Route path='/voice' element={<Voice />} />
      <Route path='/video' element={<WanI2V />} />
      <Route path='/account' element={<Account />} />
      <Route path='*' element={<Navigate to='/' replace />} />
    </Routes>
  )
}
