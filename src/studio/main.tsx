import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './App'
import { createThemeSwitch } from './chrome/theme'
import { StudioProvider } from './state/context'
import { studioStore } from './state/studio'

/** Keeps `data-theme` on <html> in step with the theme setting. */
function syncTheme(): void {
  const applyTheme = createThemeSwitch(document.documentElement)
  applyTheme(studioStore.getState().settings.theme)
  studioStore.subscribe((state, previous) => {
    if (state.settings.theme !== previous.settings.theme) applyTheme(state.settings.theme)
  })
}

function mount(): void {
  const container = document.getElementById('root')
  if (!container) throw new Error('Hindsight Studio needs an element with id "root"')
  syncTheme()
  createRoot(container).render(
    <StrictMode>
      <StudioProvider store={studioStore}>
        <App />
      </StudioProvider>
    </StrictMode>,
  )
  void studioStore.getState().startup()
}

mount()
