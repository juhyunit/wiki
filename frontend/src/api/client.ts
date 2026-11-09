import type * as T from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface Api {
  mode: 'server' | 'demo'
  // 인증
  me(): Promise<T.Me | null>
  login(username: string, password: string): Promise<T.Me>
  logout(): Promise<void>
  demoUsers(): Promise<T.DemoUsers>
  changePassword(current: string, next: string): Promise<void>
  // 탐색
  tree(): Promise<T.TreeDept[]>
  home(): Promise<T.HomeData>
  templates(): Promise<T.Template[]>
  departments(): Promise<T.Dept[]>
  department(id: number): Promise<T.DeptPage>
  deptMembers(id: number): Promise<{ id: number; name: string; position: string | null }[]>
  addCategory(deptId: number, name: string): Promise<void>
  editCategory(id: number, name: string): Promise<void>
  deleteCategory(id: number): Promise<void>
  // 매뉴얼
  createManual(body: { title: string; department_id?: number; category_id?: number | null; template_id?: number | null; visibility: string }): Promise<{ id: number }>
  manual(id: number, view?: 'published' | 'work'): Promise<T.ManualDetail>
  updateMeta(id: number, body: Record<string, any>): Promise<void>
  toggleFavorite(id: number): Promise<{ favorite: boolean }>
  archive(id: number, comment?: string): Promise<void>
  unarchive(id: number): Promise<void>
  deleteManual(id: number): Promise<void>
  // 편집
  lock(id: number): Promise<{ ok: boolean; holder?: { user_name: string; since: string } }>
  unlock(id: number, force?: boolean): Promise<void>
  workContent(id: number): Promise<T.WorkContent>
  saveDraft(id: number, title: string, content: T.Doc, keepalive?: boolean): Promise<{ saved_at: string }>
  discardDraft(id: number): Promise<void>
  saveVersion(id: number, body: { title: string; content_json: T.Doc; change_type: string; change_reason: string }): Promise<{ version_id: number; version_no: number }>
  versions(id: number): Promise<T.VersionsData>
  version(id: number, vid: number): Promise<T.VersionDetail>
  diff(id: number, a: string, b: string): Promise<T.DiffData>
  restore(id: number, vid: number): Promise<{ version_no: number }>
  requestPublish(id: number, comment?: string): Promise<void>
  publish(id: number, comment?: string): Promise<{ edition: number; version_no: number }>
  reject(id: number, comment: string): Promise<void>
  upload(id: number, file: File): Promise<T.Attachment>
  importDocx(id: number, file: File): Promise<{ html: string; messages: string[] }>
  // 문서 링크·내보내기
  links(id: number, view?: 'published' | 'work'): Promise<T.LinksData>
  exportManual(id: number, format: T.ExportFormat, view?: 'published' | 'work'): Promise<{ blob: Blob; filename: string } | { print: string }>
  // AI 질의응답
  aiStatus(): Promise<T.AiStatus>
  aiAsk(question: string, opts: { manual_id?: number | null; dept?: number | null }, onEvent: (e: T.AiEvent) => void, signal?: AbortSignal): Promise<void>
  adminAi(): Promise<T.AiAdmin>
  saveAi(body: Partial<T.AiSettings>): Promise<T.AiAdmin>
  pullAiModel(model: string): Promise<T.AiAdmin['pull']>
  aiPullStatus(): Promise<T.AiAdmin['pull']>
  deleteAiModel(model: string): Promise<T.AiAdmin>
  reindexAi(reset: boolean): Promise<T.AiAdmin>
  // 검색·알림
  search(q: string, opts?: { dept?: number | null; cat?: number | null; period?: string; work?: boolean }): Promise<T.SearchData>
  notifications(): Promise<{ items: T.Notification[]; unread: number }>
  readNotifications(): Promise<void>
  // 관리
  adminOverview(): Promise<T.AdminOverview>
  adminApprovals(): Promise<{ pending: T.ApprovalRow[]; done: T.ApprovalRow[] }>
  adminReviews(): Promise<{ due: T.Summary[]; orphans: T.Summary[] }>
  adminUsers(q?: string, dept?: number | null): Promise<T.AdminUser[]>
  createUser(body: Record<string, any>): Promise<void>
  patchUser(id: number, body: Record<string, any>): Promise<void>
  resetPassword(id: number): Promise<{ temporary_password: string }>
  adminDepartments(): Promise<T.AdminDept[]>
  createDept(body: Record<string, any>): Promise<void>
  patchDept(id: number, body: Record<string, any>): Promise<void>
  setDeptAdmin(deptId: number, userId: number, canSelfPublish: boolean): Promise<void>
  removeDeptAdmin(deptId: number, userId: number): Promise<void>
  moveManuals(deptId: number, targetId: number): Promise<{ moved: number }>
  hrSync(file: File, mode: 'preview' | 'apply', force?: boolean): Promise<T.HrPreview>
  hrRuns(): Promise<T.HrRun[]>
  audit(params: { action?: string; q?: string; offset?: number }): Promise<{ total: number; scope: string; items: T.AuditRow[] }>
  searchLogs(): Promise<{ zero: { query: string; n: number; last_at: string }[]; top: { query: string; n: number; last_at: string }[] }>
  resetDemo?(): Promise<void>
}

export let api: Api

export function setApi(a: Api) {
  api = a
}
