import { createRoot } from 'react-dom/client'
// 글꼴(모두 OFL, 가변 글꼴): 영문·숫자는 Inter, 한글은 Noto Sans KR. 코드는 시스템 고정폭 글꼴
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/noto-sans-kr/wght.css'
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
