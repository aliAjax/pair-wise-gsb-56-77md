import type {
  ApprovalLevel,
  ApprovalStep,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  ValidationFinding,
  VersionDiff,
} from '@/types/domain'

const levelRank: Record<ApprovalLevel, number> = {
  standard: 1,
  enhanced: 2,
  senior: 3,
}

export function createApprovalRoute(level: ApprovalLevel): ApprovalStep[] {
  const standard: ApprovalStep[] = [
    {
      id: `route-${crypto.randomUUID()}`,
      order: 1,
      role: '业务复核',
      assignee: '业务负责人',
      level: 'standard',
      status: 'active',
      comment: '',
    },
    {
      id: `route-${crypto.randomUUID()}`,
      order: 2,
      role: '合规审批',
      assignee: '合规专员',
      level: 'standard',
      status: 'waiting',
      comment: '',
    },
  ]
  if (level === 'enhanced' || level === 'senior') {
    standard.splice(1, 0, {
      id: `route-${crypto.randomUUID()}`,
      order: 2,
      role: '技术安全审查',
      assignee: '技术安全负责人',
      level: 'enhanced',
      status: 'waiting',
      comment: '',
    })
  }
  if (level === 'senior') {
    standard.splice(2, 0, {
      id: `route-${crypto.randomUUID()}`,
      order: 3,
      role: '高级出口管制审批',
      assignee: '出口管制委员会',
      level: 'senior',
      status: 'waiting',
      comment: '',
    })
  }
  return standard.map((step, index) => ({ ...step, order: index + 1 }))
}

export function findApplicableRule(
  packageItem: MaterialPackage,
  rules: LicenseRule[],
): LicenseRule | undefined {
  const candidates = rules.filter((rule) => {
    const categoryMatch = rule.categories.includes(packageItem.category)
    const destinationMatch =
      rule.destinations.includes('*') || rule.destinations.includes(packageItem.destination)
    const tagMatch =
      rule.technologyTags.length === 0 ||
      rule.technologyTags.some((tag) => packageItem.technologyTags.includes(tag))
    const personnelMatch =
      rule.personnelScopes.length === 0 ||
      rule.personnelScopes.some((scope) => packageItem.personnelScopes.includes(scope))
    return categoryMatch && destinationMatch && tagMatch && personnelMatch
  })
  return candidates.sort((left, right) => {
    const leftScore =
      left.destinations.length +
      left.technologyTags.length +
      left.personnelScopes.length +
      levelRank[left.approvalLevel]
    const rightScore =
      right.destinations.length +
      right.technologyTags.length +
      right.personnelScopes.length +
      levelRank[right.approvalLevel]
    return rightScore - leftScore
  })[0]
}

export function validatePackage(
  packageItem: MaterialPackage,
  files: MaterialFile[],
  rules: LicenseRule[],
): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  const packageFiles = files.filter((file) => file.packageId === packageItem.id)
  const rule = findApplicableRule(packageItem, rules)
  const add = (
    type: ValidationFinding['type'],
    level: ValidationFinding['level'],
    message: string,
    action: string,
  ) => {
    findings.push({
      id: `${packageItem.id}-${type}-${findings.length + 1}`,
      packageId: packageItem.id,
      type,
      level,
      message,
      action,
      ruleId: rule?.id,
    })
  }

  if (!rule) {
    add('escalation', 'high', '未匹配到适用许可规则，不能继续审批。', '补充规范依据或提交人工规则判定。')
    return findings
  }

  rule.requiredDeclarations.forEach((declaration) => {
    if (!packageItem.declarations.includes(declaration)) {
      add(
        'missing-declaration',
        'high',
        `缺少必要声明：${declaration}。`,
        '补充最终用途、最终用户或不扩散声明后重新校验。',
      )
    }
  })

  const currentMaxLevel = packageItem.approvalRoute.reduce(
    (max, step) => Math.max(max, levelRank[step.level]),
    0,
  )
  if (currentMaxLevel < levelRank[rule.approvalLevel]) {
    add(
      'escalation',
      'high',
      `当前审批路线最高为 ${currentMaxLevel} 级，规则要求 ${levelRank[rule.approvalLevel]} 级。`,
      '重新生成审批路线并按升级级别补签。',
    )
  }

  if (packageItem.quotaUsed >= packageItem.quotaLimit) {
    add('quota', 'high', '许可额度已用尽。', '申请额度调整或拆分至其他有效许可。')
  } else if (packageItem.quotaLimit - packageItem.quotaUsed <= 10) {
    add('quota', 'medium', '剩余许可额度不足 10%。', '审批通过前确认额度来源和扣减顺序。')
  }

  packageFiles.forEach((file) => {
    if (file.activeVersionId !== file.referencedVersionId) {
      add(
        'version-mismatch',
        'high',
        `${file.name} 当前引用版本与文件现行版本不一致。`,
        '在版本管理中显式选择唯一引用版本，禁止跨版本拼装。',
      )
    }
    const activeVersion = file.versions.find((version) => version.id === file.activeVersionId)
    const pendingPages = activeVersion?.pages.filter((page) => !page.reviewedAt) ?? []
    if (pendingPages.length) {
      add(
        'unclassified-page',
        'medium',
        `${file.name} 尚有 ${pendingPages.length} 页未完成分类核对。`,
        '逐页确认资料分类、受控技术属性和脱敏状态。',
      )
    }
  })

  return findings
}

export function diffPackageVersions(
  packageItem: MaterialPackage,
  versionId: string,
  files: MaterialFile[] = [],
): VersionDiff[] {
  const version = packageItem.versions.find((item) => item.id === versionId)
  if (!version) return []
  const diff: VersionDiff[] = []
  const fields: (keyof PackageDiffSnapshot)[] = [
    'title',
    'category',
    'destination',
    'endUse',
    'technologyTags',
    'personnelScopes',
    'declarations',
  ]
  const current: PackageDiffSnapshot = {
    title: packageItem.title,
    category: packageItem.category,
    destination: packageItem.destination,
    endUse: packageItem.endUse,
    technologyTags: packageItem.technologyTags,
    personnelScopes: packageItem.personnelScopes,
    declarations: packageItem.declarations,
  }
  fields.forEach((field) => {
    const before = version.snapshot[field]
    const after = current[field]
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      diff.push({
        id: `package-${field}`,
        field,
        before: Array.isArray(before) ? before.join('、') || '无' : String(before),
        after: Array.isArray(after) ? after.join('、') || '无' : String(after),
        kind: 'package',
      })
    }
  })
  Object.entries(version.snapshot.activeFileVersions).forEach(([fileId, beforeVersionId]) => {
    const currentVersionId =
      files.find((file) => file.id === fileId)?.activeVersionId ??
      packageItem.versions.at(-1)?.snapshot.activeFileVersions[fileId]
    if (currentVersionId && currentVersionId !== beforeVersionId) {
      diff.push({
        id: `file-${fileId}`,
        field: `文件 ${fileId} 引用版本`,
        before: beforeVersionId,
        after: currentVersionId,
        kind: 'file',
      })
    }
  })
  return diff
}

interface PackageDiffSnapshot {
  title: string
  category: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  declarations: string[]
}

export const approvalLevelLabels: Record<ApprovalLevel, string> = {
  standard: '标准审批',
  enhanced: '升级审批',
  senior: '高级审批',
}
