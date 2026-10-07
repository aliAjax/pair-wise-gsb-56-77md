import type {
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  QuotaBasis,
  QuotaReservation,
  WorkspaceState,
} from '@/types/domain'

/** 预占账异常：带上缺额，便于接口直接挡住提交并说明缺多少 */
export class QuotaShortfallError extends Error {
  requested: number
  available: number
  shortfall: number

  constructor(message: string, requested: number, available: number) {
    super(message)
    this.name = 'QuotaShortfallError'
    this.requested = requested
    this.available = available
    this.shortfall = requested - available
  }
}

/**
 * 预占规则：进入审批（含升级审批）时按规则上限整池预占，
 * 同一规则同时只允许一个在途审批持有额度，两个审批窗口因此互斥。
 */
export function holdAmountForRule(rule: LicenseRule): number {
  return rule.quotaLimit
}

export function ruleSummary(
  state: Pick<WorkspaceState, 'reservations'>,
  rule: LicenseRule,
): { limit: number; confirmed: number; held: number; available: number; overbooked: boolean } {
  const rows = state.reservations.filter((item) => item.ruleId === rule.id)
  const confirmed = rows
    .filter((item) => item.status === 'confirmed')
    .reduce((sum, item) => sum + item.amount, 0)
  const held = rows
    .filter((item) => item.status === 'held')
    .reduce((sum, item) => sum + item.amount, 0)
  return {
    limit: rule.quotaLimit,
    confirmed,
    held,
    available: rule.quotaLimit - confirmed - held,
    overbooked: confirmed + held > rule.quotaLimit,
  }
}

export function availableForRule(state: WorkspaceState, rule: LicenseRule): number {
  return ruleSummary(state, rule).available
}

export function activeHold(
  state: Pick<WorkspaceState, 'reservations'>,
  packageId: string,
): QuotaReservation | undefined {
  return state.reservations.find(
    (item) => item.packageId === packageId && item.status === 'held',
  )
}

export function findHoldingCompetitor(
  state: WorkspaceState,
  ruleId: string,
  packageId: string,
): QuotaReservation | undefined {
  return state.reservations.find(
    (item) => item.ruleId === ruleId && item.status === 'held' && item.packageId !== packageId,
  )
}

export function confirmedTotal(
  state: Pick<WorkspaceState, 'reservations'>,
  packageId: string,
): number {
  return state.reservations
    .filter((item) => item.packageId === packageId && item.status === 'confirmed')
    .reduce((sum, item) => sum + item.amount, 0)
}

export function buildBasis(
  packageItem: MaterialPackage,
  rule: LicenseRule,
  files: MaterialFile[],
  round: number,
): QuotaBasis {
  return {
    ruleId: rule.id,
    round,
    packageLabel: `V${round}.0`,
    fileVersions: files
      .filter((file) => file.packageId === packageItem.id)
      .map((file) => {
        const version =
          file.versions.find((item) => item.id === file.referencedVersionId) ??
          file.versions.find((item) => item.id === file.activeVersionId)
        return {
          fileId: file.id,
          file: file.name,
          versionId: file.referencedVersionId,
          versionLabel: version?.label ?? file.referencedVersionId,
        }
      }),
    technologyTags: [...packageItem.technologyTags],
  }
}

/** 依据是否变化：现行版本、引用版本或技术参数任一变化即失效 */
export function basisChanged(
  current: QuotaBasis | undefined,
  next: QuotaBasis,
): boolean {
  if (!current) return true
  if (current.ruleId !== next.ruleId) return true
  if (JSON.stringify([...current.technologyTags].sort()) !== JSON.stringify([...next.technologyTags].sort())) {
    return true
  }
  const currentFiles = new Map(current.fileVersions.map((item) => [item.fileId, item.versionId]))
  if (currentFiles.size !== next.fileVersions.length) return true
  return next.fileVersions.some((item) => currentFiles.get(item.fileId) !== item.versionId)
}

export function basisVersionLabel(basis: QuotaBasis | undefined): string {
  if (!basis) return '无依据'
  const files = basis.fileVersions.map((item) => item.versionLabel).join('、')
  return `${basis.packageLabel}${files ? ` / 文件 ${files}` : ''}`
}

interface HoldInput {
  state: WorkspaceState
  rule: LicenseRule
  packageItem: MaterialPackage
  basis: QuotaBasis
  reason: string
  nowText: string
  batchId?: string
  reservationId?: string
}

/**
 * 预占额度：不足直接抛 QuotaShortfallError（由调用方落冲突、留意见后挡住提交）。
 * reservationId 固定时为重试/恢复，保证不重复扣减。
 */
export function applyHold(input: HoldInput): QuotaReservation {
  const { state, rule, packageItem, basis, reason, nowText, batchId, reservationId } = input
  const amount = holdAmountForRule(rule)
  const competitor = findHoldingCompetitor(state, rule.id, packageItem.id)
  const summary = ruleSummary(state, rule)
  if (competitor || summary.available < amount) {
    throw new QuotaShortfallError(
      competitor
        ? `额度已被资料包「${competitorPackageLabel(state, competitor.packageId)}」的在途审批预占，本规则上限 ${rule.quotaLimit}，当前可用 ${Math.max(0, summary.available)}，预占 ${amount} 缺额 ${amount - Math.max(0, summary.available)}。`
        : `许可额度不足：规则「${rule.name}」上限 ${rule.quotaLimit}，已确认 ${summary.confirmed}、预占 ${summary.held}，可用 ${summary.available}，本次预占 ${amount}，缺额 ${amount - summary.available}。`,
      amount,
      Math.max(0, summary.available),
    )
  }
  const reservation: QuotaReservation = {
    id: reservationId ?? `hold-${crypto.randomUUID()}`,
    ruleId: rule.id,
    packageId: packageItem.id,
    round: basis.round,
    amount,
    status: 'held',
    reason,
    basis,
    createdAt: nowText,
    updatedAt: nowText,
    sourceBatchId: batchId,
  }
  state.reservations.push(reservation)
  return reservation
}

function competitorPackageLabel(state: WorkspaceState, packageId: string): string {
  return state.packages.find((item) => item.id === packageId)?.code ?? packageId
}

/**
 * 依据变化后按新版本重算：先作废旧预占（已完成审批的原确认保留，不参与作废），
 * 再按当前规则上限重新预占；额度不足时抛出，资料包转入待恢复且不重复占用。
 */
export function reholdForBasisChange(input: {
  state: WorkspaceState
  rule: LicenseRule
  packageItem: MaterialPackage
  basis: QuotaBasis
  reason: string
  nowText: string
}): { reservation: QuotaReservation } {
  const { state, rule, packageItem, basis, reason, nowText } = input
  const old = activeHold(state, packageItem.id)
  // 先放旧预占回池，再按新依据申请，避免自己挡自己
  if (old) {
    old.status = 'voided'
    old.updatedAt = nowText
    old.reason = `${old.reason}；依据变化（${reason}）后作废，已完成审批保留原依据。`
  }
  let reservation: QuotaReservation
  try {
    reservation = applyHold({
      state,
      rule,
      packageItem,
      basis,
      reason: `依据变化重算预占（${reason}）`,
      nowText,
    })
  } catch (error) {
    if (old) old.replacedBy = undefined
    throw error
  }
  if (old) old.replacedBy = reservation.id
  packageItem.quotaBasis = basis
  return { reservation }
}

/** 退回 / 依据失效后释放预占回池 */
export function releaseHold(
  state: Pick<WorkspaceState, 'reservations'>,
  packageId: string,
  nowText: string,
  note: string,
  replacedBy?: string,
): void {
  state.reservations
    .filter((item) => item.packageId === packageId && item.status === 'held')
    .forEach((item) => {
      item.status = 'released'
      item.updatedAt = nowText
      item.replacedBy = replacedBy
      item.reason = `${item.reason}；${note}`
    })
}

/** 审批全部完成后确认扣减：held -> confirmed，并释放超出实扣的剩余预占回池 */
export function confirmHold(input: {
  state: Pick<WorkspaceState, 'reservations'>
  reservation: QuotaReservation
  amount: number
  nowText: string
}): void {
  const { state, reservation, amount, nowText } = input
  if (reservation.status === 'confirmed') return
  reservation.status = 'confirmed'
  reservation.amount = amount
  reservation.updatedAt = nowText
  reservation.reason = `${reservation.reason}；审批完成，确认扣减 ${amount}。`
  // 同批次/同轮次若有其它 held（正常不会），一并释放，杜绝重复占用
  state.reservations
    .filter(
      (item) =>
        item.id !== reservation.id &&
        item.packageId === reservation.packageId &&
        item.round === reservation.round &&
        item.status === 'held',
    )
    .forEach((item) => {
      item.status = 'released'
      item.updatedAt = nowText
      item.reason = `${item.reason}；同轮预占已确认扣减，剩余额度释放回池。`
    })
}

/** 把台账数字同步回资料包字段（quotaUsed 只由 confirmed 决定） */
export function syncPackageQuota(state: WorkspaceState, packageItem: MaterialPackage): void {
  const rule = state.rules.find((item) => item.id === packageItem.matchedRuleId)
  packageItem.quotaUsed = confirmedTotal(state, packageItem.id)
  packageItem.quotaLimit = rule?.quotaLimit ?? packageItem.quotaLimit
}

/**
 * 旧数据升级回填基线：历史已用额度记为 confirmed 基线（不重新占用预占池外的新额度），
 * 审批中的资料包按当前状态与规则上限回填一笔 held 基线。
 */
export function backfillBaselineReservations(
  state: WorkspaceState,
  options: { baseline: boolean },
): void {
  const { baseline } = options
  state.packages.forEach((packageItem) => {
    const rule = state.rules.find((item) => item.id === packageItem.matchedRuleId)
    if (!rule) return
    if (packageItem.quotaUsed > 0) {
      state.reservations.push({
        id: `baseline-confirmed-${packageItem.id}`,
        ruleId: rule.id,
        packageId: packageItem.id,
        round: Math.max(1, packageItem.currentRound),
        amount: packageItem.quotaUsed,
        status: 'confirmed',
        reason: baseline
          ? '旧数据升级回填：历史已确认扣减额度，仅作基线，不重新占用。'
          : '演示基线：历史已确认扣减额度。',
        createdAt: packageItem.createdAt,
        updatedAt: packageItem.updatedAt,
      })
    }
    if (packageItem.status === 'reviewing') {
      state.reservations.push({
        id: `baseline-held-${packageItem.id}`,
        ruleId: rule.id,
        packageId: packageItem.id,
        round: packageItem.currentRound,
        amount: rule.quotaLimit,
        status: 'held',
        reason: baseline
          ? '旧数据升级回填：按当前“审批中”状态与规则上限回填预占基线。'
          : '演示基线：按当前“审批中”状态与规则上限回填预占。',
        createdAt: packageItem.updatedAt,
        updatedAt: packageItem.updatedAt,
      })
      if (!packageItem.quotaBasis) {
        packageItem.quotaBasis = buildBasis(packageItem, rule, state.files, packageItem.currentRound)
      }
    } else if (packageItem.status === 'approved' && packageItem.quotaUsed < rule.quotaLimit) {
      // 已完成审批、等待确认扣减：仍占着剩余预占，直到许可确认或归档
      state.reservations.push({
        id: `baseline-held-${packageItem.id}`,
        ruleId: rule.id,
        packageId: packageItem.id,
        round: packageItem.currentRound,
        amount: rule.quotaLimit - packageItem.quotaUsed,
        status: 'held',
        reason: baseline
          ? '旧数据升级回填：审批已完成待许可确认，按剩余额度回填预占基线。'
          : '演示基线：审批已完成待许可确认，按剩余额度回填预占。',
        createdAt: packageItem.updatedAt,
        updatedAt: packageItem.updatedAt,
      })
      if (!packageItem.quotaBasis) {
        packageItem.quotaBasis = buildBasis(packageItem, rule, state.files, packageItem.currentRound)
      }
    }
  })
  state.packages.forEach((packageItem) => syncPackageQuota(state, packageItem))
}
