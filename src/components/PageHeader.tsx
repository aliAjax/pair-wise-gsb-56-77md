import type { ReactNode } from 'react'

interface Props {
  title: string
  description: string
  actions?: ReactNode
}

export function PageHeader({ title, description, actions }: Props) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}
