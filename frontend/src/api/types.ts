export type Doc = { type: 'doc'; content?: any[] }

export interface Me {
  id: number
  username: string
  name: string
  position: string | null
  department_id: number | null
  department_name: string | null
  roles: string[]
  admin_depts: { id: number; name: string; can_self_publish: boolean }[]
  unread: number
}

export interface DemoUsers {
  enabled: boolean
  password_hint?: string
  users: { username: string; name: string; position: string; department: string; role: string }[]
}

export interface TreeManual {
  id: number
  manual_no: string
  title: string
  category_id: number | null
  status: string
  has_work: boolean
  review_state: string
}
export interface TreeDept {
  id: number
  code: string
  name: string
  categories: { id: number; name: string }[]
  manuals: TreeManual[]
}

export interface Summary {
  id: number
  manual_no: string
  title: string
  department_id: number
  department_name: string
  category_id: number | null
  category_name: string | null
  owner_name: string | null
  owner_active: boolean
  status: 'draft' | 'published' | 'archived'
  review_state: 'none' | 'in_review'
  visibility: 'company' | 'department'
  edition: number
  version_no: number | null
  latest_version_no: number | null
  published_at: string | null
  updated_at: string
  next_review_date: string | null
  review_overdue: boolean
  has_work: boolean
  tags: string[]
}

export interface PendingItem {
  id: number
  manual_id: number
  title: string
  manual_no: string
  department_name: string
  version_no: number
  requester: string
  requested_at: string
  comment: string | null
}

export interface HomeData {
  recent: Summary[]
  favorites: Summary[]
  my_drafts: Summary[]
  pending_role: 'decide' | 'mine'
  pending: PendingItem[]
  review_due: Summary[]
  popular: Summary[]
  counts: { published: number; my_dept: number; pending: number; overdue: number }
}

export interface Template { id: number; name: string; description: string; department_id: number | null }
export interface Dept { id: number; code: string; name: string; approval_mode: 'required' | 'skip' }

export interface DeptPage {
  id: number
  code: string
  name: string
  approval_mode: 'required' | 'skip'
  categories: { id: number; name: string; sort_order: number }[]
  admins: string[]
  manuals: Summary[]
  perms: { create: boolean; manage_categories: boolean }
}

export interface Attachment { id: number; kind: string; name: string; mime: string; size: number; url: string; uploaded_at?: string }

export interface Perms {
  view_work: boolean
  edit: boolean
  request_publish: boolean
  publish: boolean
  publish_any: boolean
  reject: boolean
  manage: boolean
  force_unlock: boolean
}

export interface TocItem { id: string; level: number; text: string }

export interface ManualDetail extends Summary {
  view: 'published' | 'work'
  can_view_published: boolean
  content_html: string
  toc: TocItem[]
  shown_version_no: number | null
  shown_title: string
  published: { version_id: number; version_no: number; edition: number; published_at: string; published_by_name: string | null } | null
  draft: { saved_at: string; user_name: string; mine: boolean } | null
  pending: { id: number; version_id: number; version_no: number; requester: string; requested_at: string; comment: string | null } | null
  rejection: { comment: string; decider: string; decided_at: string } | null
  lock: { user_id: number; user_name: string; since: string } | null
  attachments: Attachment[]
  extra_department_ids: number[]
  owner_id: number | null
  review_cycle_months: number
  dept_approval_mode: 'required' | 'skip'
  is_favorite: boolean
  views_30d: number
  perms: Perms
}

export interface WorkContent {
  title: string
  content_json: Doc
  source: 'draft' | 'version' | 'empty'
  draft_saved_at: string | null
  draft_user_name: string | null
  base_version_no: number | null
}

export interface VersionRow {
  id: number
  version_no: number
  title: string
  change_type: string | null
  change_reason: string | null
  created_at: string
  published_at: string | null
  edition_no: number | null
  author: string | null
  publisher: string | null
  is_published: boolean
  is_latest: boolean
}
export interface VersionsData {
  manual: { id: number; title: string; manual_no: string; department_id: number; published_version_id: number | null; latest_version_id: number | null }
  draft: { saved_at: string; user_name: string } | null
  versions: VersionRow[]
  perms: { edit: boolean }
}
export interface VersionDetail {
  id: number
  version_no: number
  title: string
  html: string
  toc: TocItem[]
  created_at: string
  author: string | null
  change_type: string | null
  change_reason: string | null
  edition_no: number | null
  published_at: string | null
}
export interface DiffData { from_label: string; to_label: string; html: string; stats: { added: number; removed: number; changed: number } }

export interface SearchResult extends Summary { scope: 'published' | 'work'; score: number; title_html: string; snippet_html: string }
export interface SearchData { results: SearchResult[]; total: number }

export interface Notification { id: number; at: string; kind: string; message: string; manual_id: number | null; read_at: string | null }

export interface AdminOverview {
  counts: { users: number | null; published: number; drafts: number; pending: number; overdue: number; searches_7d: number; views_7d: number }
  by_dept: { id: number; code: string; name: string; approval_mode: string; is_active: boolean; published: number; drafts: number; pending: number; overdue: number; archived: number; admins: string[]; members: number }[]
  zero_searches: { query: string; n: number; last_at: string }[]
  roles: { sys_admin: boolean; auditor: boolean; dept_admin: boolean }
}
export interface ApprovalRow {
  id: number; manual_id: number; title: string; manual_no: string; department_name: string; version_no: number
  change_type: string | null; change_reason: string | null; requester: string | null; requested_at: string
  request_comment: string | null; decision: string; decider: string | null; decided_at: string | null; comment: string | null; can_decide: boolean
}
export interface AdminUser {
  id: number; employee_no: string; username: string; name: string; position: string | null; email: string | null
  department_id: number | null; dept_name: string | null; is_active: number; is_local_admin: number; created_at: string
  roles: string[]; admin_of: string[]
}
export interface AdminDept {
  id: number; code: string; name: string; approval_mode: 'required' | 'skip'; is_active: number; sort_order: number
  admins: { id: number; name: string; position: string | null; can_self_publish: number }[]; members: number
}
export interface HrPreview {
  create: { employee_no: string; name: string; department_code: string; position: string | null }[]
  update: { employee_no: string; name: string; changes: Record<string, any> }[]
  deactivate: { employee_no: string; name: string; reason: string }[]
  errors: string[]
  blocked: boolean
  ratio: number
  threshold: number
  applied: boolean
}
export interface HrRun { id: number; started_at: string; finished_at: string | null; run_by_name: string; created: number; updated: number; deactivated: number; status: string; error: string | null }
export interface AuditRow { id: number; at: string; actor_name: string | null; action: string; target_type: string | null; target_id: string | null; target_label: string | null; ip: string | null; detail: Record<string, any> }
