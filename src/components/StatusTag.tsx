import { Tag } from 'antd'
import type { PackageStatus } from '@/types/domain'
import { packageStatusLabels } from '@/services/mockData'

const colors: Record<PackageStatus, string> = {
  draft: 'default',
  validating: 'processing',
  reviewing: 'gold',
  returned: 'error',
  approved: 'cyan',
  licensed: 'green',
  locked: 'blue',
}

export function StatusTag({ status }: { status: PackageStatus }) {
  return <Tag color={colors[status]}>{packageStatusLabels[status]}</Tag>
}
