import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import { AppProviders } from './providers/AppProviders'
// Self-hosted, bundled by Vite — the CSP admits no font host but our own.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AppProviders>
        <App />
      </AppProviders>
    </BrowserRouter>
  </StrictMode>,
)
