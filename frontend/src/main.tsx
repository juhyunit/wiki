import { createRoot } from 'react-dom/client'
// 글꼴은 웹폰트 없이 운영체제 기본 글꼴을 쓴다(styles.css의 --font, Notion과 같은 방식)
import './styles.css'
import { setApi } from './api/client'
import { httpApi } from './api/http'
import App from './App'
import { DialogProvider, ToastProvider } from './components/ui'

declare const __DEMO__: boolean

async function boot() {
  if (__DEMO__) {
    const { createDemoApi } = await import('./api/demo')
    setApi(await createDemoApi())
  } else {
    setApi(httpApi)
  }
  createRoot(document.getElementById('root')!).render(
    <ToastProvider>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ToastProvider>,
  )
}

boot()
