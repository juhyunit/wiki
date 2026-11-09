import { Briefcase, Building2, Folder, Landmark, ShieldCheck, Users, Wallet } from 'lucide-react'

// 부서 구분용 아이콘. 색은 쓰지 않고 모양만 다르게 한다(디자인 가이드: 메뉴마다 색 적용 금지)
const MAP: Record<string, any> = { HR: Users, LN: Landmark, DP: Wallet, SEC: ShieldCheck, GA: Building2 }

export function DeptIcon({ code, size = 16 }: { code?: string; size?: number }) {
  const Icon = (code && MAP[code]) || (code ? Briefcase : Folder)
  return <Icon size={size} className="dept-icon" aria-hidden="true" />
}
