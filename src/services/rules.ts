import type {
  ApprovalLevel,
  ApprovalStep,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  QuotaReservation,
  ValidationFinding,
  VersionDiff,
} from '@/types/domain'
import { activeHold, ruleSummary } from './quota'

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
    // 精确命中目的地的规则始终优先于仅靠“*”兜底的规则
    const specificity = (rule: LicenseRule) =>
      (rule.destinations.includes('*') ? 0 : 100 + rule.destinations.length) +
      rule.technologyTags.length * 10 +
      rule.personnelScopes.length * 10 +
      levelRank[rule.approvalLevel]
    return specificity(right) - specificity(left)
  })[0]
}

export function validatePackage(
  packageItem: MaterialPackage,
  files: MaterialFile[],
  rules: LicenseRule[],
  ledger?: Pick<import('@/types/domain').WorkspaceState, 'reservations' | 'conflicts'>,
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
  if (
    currentMaxLevel < levelRank[rule.approvalLevel] &&
    packageItem.status !== 'draft' &&
    packageItem.currentRound > 0
  ) {
    add(
      'escalation',
      'high',
      `当前审批路线最高为 ${currentMaxLevel} 级，规则要求 ${levelRank[rule.approvalLevel]} 级。`,
      '重新生成审批路线并按升级级别补签。',
    )
  }

  // 额度口径：已确认 + 预占占用规则池，审批窗口互斥
  const reservations: QuotaReservation[] = ledger?.reservations ?? []
  const summary = ruleSummary({ reservations }, rule)
  const hold = activeHold({ reservations }, packageItem.id)
  if (packageItem.status === 'quota-blocked') {
    add(
      'quota',
      'high',
      '文件换版、引用版本或技术参数变化后，原预占已失效，而新依据重算预占时额度不足。',
      '等待额度释放后在审批页恢复预占，或调整资料后重新提交；已通过步骤保留原依据。',
    )
  } else if (hold) {
    if (summary.overbooked) {
      add(
        'quota',
        'medium',
        `本规则池存在历史基线超占（已确认 ${summary.confirmed} + 预占 ${summary.held} / 上限 ${summary.limit}），为旧数据升级基线，不影响当前在途预占。`,
        '待历史批次释放后自动回归正常水位。',
      )
    }
    if (summary.available <= 0 && packageItem.status === 'reviewing') {
      add(
        'quota',
        'medium',
        `当前资料包已预占 ${hold.amount}（规则上限整池），审批完成前额度不会被其他窗口重复占用。`,
        '完成全部审批后确认扣减，或退回释放预占。',
      )
    }
  } else if (
    ['reviewing', 'approved'].includes(packageItem.status) &&
    packageItem.status !== 'licensed'
  ) {
    add(
      'quota',
      'high',
      '在途审批缺少有效额度预占，提交/确认前必须先预占成功。',
      '重新提交审批或恢复未完成预占批次。',
    )
  }
  if (summary.limit - summary.confirmed <= 0 && !hold) {
    add('quota', 'high', `规则「${rule.name}」许可额度已全部确认使用。`, '申请额度调整或拆分至其他有效许可。')
  } else if (summary.limit - summary.confirmed - summary.held <= 10 && !hold) {
    add('quota', 'medium', '规则池剩余可预占额度不足 10%。', '审批提交前确认额度来源和预占顺序。')
  }

  // 并发抢额度失败的冲突：竞争者仍持有时才阻断，释放后历史冲突只留在台账中
  const openConflict = ledger?.conflicts.find((item) => item.packageId === packageItem.id)
  const conflictStillHeld = openConflict
    ? reservations.some(
        (item) => item.packageId === openConflict.competitorPackageId && item.status === 'held',
      )
    : false
  if (openConflict && conflictStillHeld) {
    add(
      'quota-conflict',
      'high',
      `并发提交冲突：规则「${rule.name}」额度已被先到的审批窗口预占，本次缺额 ${openConflict.shortfall}。`,
      '查看冲突意见，待对方释放额度后重新提交并重算预占。',
    )
  }

  packageFiles.forEach((file) => {
    if (file.activeVersionId !== file.referencedVersionId) {
      add(
        'version-mismatch',
        'high',
        `${file.name} 当前引用版本与文件现行版本不一致。`,
        '在版本管理中显式选择唯一引用版本；切换后在途审批预占将按新依据重算。',
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
