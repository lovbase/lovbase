import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import { App } from './App'
import { startAnalytics } from './lib/analytics'

startAnalytics()

createRoot(document.getElementById('root')!).render(
  <BrowserRouter><App /></BrowserRouter>,
)
