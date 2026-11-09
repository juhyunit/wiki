import { AnchorHTMLAttributes, ReactNode } from 'react'
import { href, navigate } from '../lib/router'

export function Link({ to, children, onNavigate, ...rest }: { to: string; children: ReactNode; onNavigate?: () => void } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={href(to)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        onNavigate?.()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}
