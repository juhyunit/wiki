import { ReactNode } from 'react'
import { DeptIcon } from './DeptIcon'
import { Link } from './Link'

export type Crumb = { label: string; to?: string; code?: string }

export function PageHeader({ crumbs, actions }: { crumbs: Crumb[]; actions?: ReactNode }) {
  return (
    <div className="topbar">
      <nav className="crumbs" aria-label="위치">
        {crumbs.map((c, i) => {
          const inner = <>{c.code && <DeptIcon code={c.code} size={15} />}<span>{c.label}</span></>
          return (
            <span key={i} className="crumb">
              {i > 0 && <span className="crumb-sep">/</span>}
              {c.to ? <Link to={c.to} className="crumb-link">{inner}</Link> : <span className="crumb-current">{inner}</span>}
            </span>
          )
        })}
      </nav>
      <div className="topbar-actions">{actions}</div>
    </div>
  )
}
