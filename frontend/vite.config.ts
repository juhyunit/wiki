import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// server 모드: FastAPI가 제공할 화면을 backend/app/static에 빌드
// demo 모드: 서버 없이 브라우저 저장소로 동작하는 데모(dist-demo). demo-public(헤더·robots)은 데모에만 넣는다
export default defineConfig(({ mode }) => ({
  base: './',
  publicDir: mode === 'demo' ? 'demo-public' : false,
  plugins: [react()],
  define: { __DEMO__: JSON.stringify(mode === 'demo') },
  build: {
    outDir: mode === 'demo' ? 'dist-demo' : '../backend/app/static',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { proxy: { '/api': 'http://localhost:8000' } },
}))
