import { createContext, useContext } from 'react'
import type { AiStatus, Me, TreeDept } from './api/types'

export interface AppState {
  me: Me
  setMe: (m: Me | null) => void
  tree: TreeDept[]
  reloadTree: () => void
  refreshMe: () => void
  openNewManual: (deptId?: number) => void
  isAdminAny: boolean
  openSidebar: () => void
  ai: AiStatus | null
  reloadAi: () => void
}

export const AppCtx = createContext<AppState>(null as any)
export const useApp = () => useContext(AppCtx)
