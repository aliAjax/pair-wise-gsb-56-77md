import type {
  ApprovalLevel,
  ApprovalStep,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  QuotaBasis,
  QuotaPoolSnapshot,
  QuotaReservation,
  WorkspaceState,
} from '../types/domain'
import { createApprovalRoute, findApplicableRule } from './rules'

/**
 * 额度预占账（held = 审批中预占；settled = 审批完成转实占）。
 * 同一许可规则下的所有资料包共用同一份额度池，任何预占/实占都以账本行为准，
 * 保证“先到者生效、重试不重复扣减、历史已用不重新占用”。
 */

export class QuotaError extends Error {
  shortage?: number
  blocker?: string
  conflictReservationId?: string

  constructor(
    message: string,
    meta: { shortage?: number; blocker?: string; conflictReservationId?: string } = {},
  ) {
    super(message)
    this.name = 'QuotaError'
    this.shortage = meta.shortage
    this.blocker = meta.blocker
    this.conflictReservationId = meta.conflictReservationId
  }
}

export interface AuditEvent {
  packageId?: string
  action: string
  target: string
  operator: string
  detail: string
}

export interface OperationResult {
  reservation: QuotaReservation
  events: AuditEvent[]
}

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function fileMap(files: MaterialFile[], packageId: string): {
  references: Record<string, string>
  active: Record<string, string>
  hashes: Record<string, string>
} {
  const references: Record<string, string> = {}
  const active: Record<string, string> = {}
  const hashes: Record<string, string> = {}
  files
    .filter((file) => file.packageId === packageId)
    .forEach((file) => {
      references[file.id] = file.referencedVersionId
      active[file.id] = file.activeVersionId
      hashes[file.id] =
        file.versions.find((version) => version.id === file.referencedVersionId)?.hash ?? ''
    })
  return { references, active, hashes }
}

/** 计算资料包当前的预占依据：规则、技术参数、文件现行/引用版本。 */
export function buildBasis(
  packageItem: MaterialPackage,
  files: MaterialFile[],
  rule: LicenseRule,
): QuotaBasis {
  const { references, active, hashes } = fileMap(files, packageItem.id)
  return {
    ruleId: rule.id,
    technologyTags: [...packageItem.technologyTags].sort(),
    category: packageItem.category,
    destination: packageItem.destination,
    declarations: [...packageItem.declarations].sort(),
    personnelScopes: [...packageItem.personnelScopes].sort(),
    fileReferences: references,
    fileActive: active,
    fileHashes: hashes,
  }
}

/** 依据指纹：任一关键字段变化即视为旧依据失效。 */
export function basisKey(basis: QuotaBasis): string {
  return JSON.stringify({
    r: basis.ruleId,
    c: basis.category,
    d: basis.destination,
    t: basis.technologyTags,
    p: basis.personnelScopes,
    dec: basis.declarations,
    ref: Object.fromEntries(Object.entries(basis.fileReferences).sort()),
    act: Object.fromEntries(Object.entries(basis.fileActive).sort()),
    h: Object.fromEntries(Object.entries(basis.fileHashes).sort()),
  })
}

export function isSameBasis(left: QuotaBasis, right: QuotaBasis): boolean {
  return basisKey(left) === basisKey(right)
}

/** 进入（升级）审批时按规则上限整额预占。 */
export function reservationAmount(rule: LicenseRule): number {
  return rule.quotaLimit
}

/** 汇总某条规则的额度池占用（只统计 held / settled，其余状态不占额）。 */
export function poolUsage(
  reservations: QuotaReservation[],
  ruleId: string,
): { settled: number; held: number } {
  return reservations
    .filter((item) => item.ruleId === ruleId)
    .reduce(
      (total, item) => {
        if (item.status === 'held') total.held += item.amount
        else if (item.status === 'settled') total.settled += item.amount
        return total
      },
      { settled: 0, held: 0 },
    )
}

export function quotaPools(state: WorkspaceState): QuotaPoolSnapshot[] {
  return state.rules.map((rule) => {
    const { settled, held } = poolUsage(state.reservations ?? [], rule.id)
    const committed = settled + held
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      limit: rule.quotaLimit,
      settled,
      held,
      committed,
      available: rule.quotaLimit - committed,
    }
  })
}

export function activeHeldReservation(
  state: WorkspaceState,
  packageId: string,
): QuotaReservation | undefined {
  return state.reservations.find(
    (item) => item.packageId === packageId && item.status === 'held',
  )
}

function findBlockingHeld(
  state: WorkspaceState,
  ruleId: string,
  excludePackageId?: string,
): QuotaReservation | undefined {
  const held = state.reservations
    .filter((item) => item.ruleId === ruleId && item.status === 'held')
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
  return held.find((item) => item.packageId !== excludePackageId)
}

/**
 * 预占核心：校验额度池并写入账本。
 * - 同一资料包已有在途预占：视为并发抢同一额度，后来者记 conflicted 并保留意见。
 * - 额度被其他在途审批抢占：先到者生效，后来者记 conflicted 并说明缺额。
 * - 额度仅被历史实占用尽：硬阻断，说明缺额。
 */
function holdReservation(params: {
  state: WorkspaceState
  packageItem: MaterialPackage
  rule: LicenseRule
  amount: number
  basis: QuotaBasis
  now: string
  operator: string
  comment?: string
  round: number
  markFailed?: boolean
}): OperationResult {
  const { state, packageItem, rule, amount, basis, now, operator, comment, round, markFailed } =
    params

  const duplicate = activeHeldReservation(state, packageItem.id)
  if (duplicate) {
    return rejectAsConflict({
      state,
      packageItem,
      rule,
      amount,
      basis,
      now,
      operator,
      comment,
      round,
      blocker: duplicate,
      reason: `资料包已有第 ${duplicate.round} 轮在途审批先到生效（预占账 ${duplicate.id}），本次提交不重复占用额度。`,
    })
  }

  const { settled, held } = poolUsage(state.reservations, rule.id)
  const available = rule.quotaLimit - settled - held
  if (amount > available) {
    const shortage = amount - available
    const competitor = findBlockingHeld(state, rule.id, packageItem.id)
    if (competitor) {
      return rejectAsConflict({
        state,
        packageItem,
        rule,
        amount,
        basis,
        now,
        operator,
        comment,
        round,
        blocker: competitor,
        reason: `额度竞争落败：规则「${rule.name}」已被先提交的审批预占，当前可预占 ${available}，本次按规则上限需 ${amount}，缺额 ${shortage}。`,
      })
    }
    throw new QuotaError(
      `额度不足，已挡住提交：规则「${rule.name}」总额 ${rule.quotaLimit}，已实占 ${settled}、在途预占 ${held}，本次需要 ${amount}，缺额 ${shortage}。`,
      { shortage },
    )
  }

  const reservation: QuotaReservation = {
    id: uid('res'),
    packageId: packageItem.id,
    ruleId: rule.id,
    round,
    amount,
    status: markFailed ? 'failed' : 'held',
    basis,
    versionToken: crypto.randomUUID(),
    pendingComment: comment || undefined,
    submittedBy: operator,
    submittedAt: now,
  }
  state.reservations.push(reservation)

  if (markFailed) {
    // 写入异常退出：批次（预占账 + 依据 + 意见）已完整落盘，审批路线尚未生成，等待恢复。
    return {
      reservation,
      events: [
        {
          packageId: packageItem.id,
          action: '预占写入中断',
          target: packageItem.code,
          operator,
          detail: `批次 ${reservation.id} 在写入审批路线前异常退出，预占账与依据已完整保留，恢复时不会重复扣减。`,
        },
      ],
    }
  }

  return {
    reservation,
    events: [
      {
        packageId: packageItem.id,
        action: '预占许可额度',
        target: packageItem.code,
        operator,
        detail: `按规则「${rule.name}」上限预占 ${amount}，第 ${round} 轮审批在途；池内实占 ${settled}、预占 ${held + amount}。`,
      },
    ],
  }
}

function rejectAsConflict(params: {
  state: WorkspaceState
  packageItem: MaterialPackage
  rule: LicenseRule
  amount: number
  basis: QuotaBasis
  now: string
  operator: string
  comment?: string
  round: number
  blocker: QuotaReservation
  reason: string
}): OperationResult {
  const { state, packageItem, rule, amount, basis, now, operator, comment, round, blocker, reason } =
    params
  const conflicted: QuotaReservation = {
    id: uid('res'),
    packageId: packageItem.id,
    ruleId: rule.id,
    round,
    amount,
    status: 'conflicted',
    basis,
    versionToken: crypto.randomUUID(),
    conflictWith: blocker.id,
    conflictReason: reason,
    pendingComment: comment || '',
    submittedBy: operator,
    submittedAt: now,
  }
  state.reservations.push(conflicted)
  packageItem.pendingConflict = {
    reservationId: conflicted.id,
    reason,
    comment: comment || '',
    at: now,
  }
  throw new QuotaError(`${reason}您的意见已保留在冲突批次 ${conflicted.id} 中。`, {
    blocker: blocker.id,
    conflictReservationId: conflicted.id,
  })
}

/**
 * 合并新一轮审批路线：已通过步骤连同其原预占依据完整保留，
 * 仅重建未完成步骤——文件换版后旧审批仍有效。
 */
export function mergeRoute(
  existing: ApprovalStep[],
  level: ApprovalLevel,
): ApprovalStep[] {
  const fresh = createApprovalRoute(level)
  let consumedApproved = false
  const merged = fresh.map((step) => {
    const previous = existing.find((item) => item.order === step.order)
    if (!consumedApproved && previous?.status === 'approved') {
      return {
        ...step,
        status: 'approved' as const,
        comment: previous.comment,
        decidedAt: previous.decidedAt,
        basisReservationId: previous.basisReservationId,
      }
    }
    consumedApproved = true
    return step
  })
  const firstOpen = merged.findIndex((step) => step.status !== 'approved')
  merged.forEach((step, index) => {
    if (step.status === 'approved') return
    step.status = index === firstOpen ? 'active' : 'waiting'
  })
  return merged
}

export interface SubmitOptions {
  now: string
  operator?: string
  comment?: string
  simulateCrash?: boolean
}

/** 进入审批：匹配规则、按上限预占、生成（或合并）审批路线。 */
export function submitForApproval(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  options: SubmitOptions,
): OperationResult {
  const operator = options.operator ?? '当前用户'
  const rule = findApplicableRule(packageItem, state.rules)
  if (!rule) throw new QuotaError('未匹配到许可规则，不能预占额度。')
  const basis = buildBasis(packageItem, state.files, rule)
  const amount = reservationAmount(rule)
  const round = packageItem.currentRound + 1

  const result = holdReservation({
    state,
    packageItem,
    rule,
    amount,
    basis,
    now: options.now,
    operator,
    comment: options.comment,
    round,
    markFailed: options.simulateCrash,
  })

  if (options.simulateCrash) return result

  packageItem.activeReservationId = result.reservation.id
  packageItem.pendingConflict = undefined
  packageItem.quotaBlocked = undefined
  packageItem.matchedRuleId = rule.id
  packageItem.approvalRoute = mergeRoute(packageItem.approvalRoute, rule.approvalLevel)
  packageItem.status = 'reviewing'
  packageItem.currentRound = round
  result.events.push({
    packageId: packageItem.id,
    action: '提交审批',
    target: packageItem.code,
    operator,
    detail: `按 ${rule.name} 生成审批路线，第 ${round} 轮；预占账 ${result.reservation.id}。`,
  })
  return result
}

/** 审批步骤通过：记录所依据的预占账；全部通过时预占转实占（等审批全过才扣）。 */
export function approveStep(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  step: ApprovalStep,
  now: string,
): AuditEvent[] {
  const events: AuditEvent[] = []
  const reservation = state.reservations.find(
    (item) => item.id === packageItem.activeReservationId && item.status === 'held',
  )
  step.status = 'approved'
  step.decidedAt = now
  step.basisReservationId = reservation?.id
  const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
  if (next) {
    next.status = 'active'
    return events
  }

  // 最后一步通过：预占转实占。幂等：若批次已结算则不重复扣减。
  if (!reservation) {
    packageItem.status = 'licensed'
    return events
  }
  settleReservation(state, reservation, now, events)
  packageItem.status = 'licensed'
  packageItem.activeReservationId = undefined
  events.push({
    packageId: packageItem.id,
    action: '许可额度实占',
    target: packageItem.code,
    operator: step.assignee,
    detail: `第 ${reservation.round} 轮审批全部通过，预占账 ${reservation.id} 转实占 ${reservation.amount}。`,
  })
  return events
}

function settleReservation(
  state: WorkspaceState,
  reservation: QuotaReservation,
  now: string,
  events: AuditEvent[],
): void {
  if (reservation.status === 'settled') return
  const packageItem = state.packages.find((item) => item.id === reservation.packageId)
  // held 已占用额度，转 settled 只改状态，不能再次累加；baseline 行的金额历史上已计入 quotaUsed。
  reservation.status = 'settled'
  reservation.settledAt = now
  if (packageItem && !reservation.baseline) {
    packageItem.quotaUsed += reservation.amount
  }
  events.push({
    packageId: reservation.packageId,
    action: '预占转实占',
    target: packageItem?.code ?? reservation.packageId,
    operator: '系统',
    detail: `预占账 ${reservation.id} 结算 ${reservation.amount}，池内额度不重复扣减。`,
  })
}

/** 审批退回：释放未完成预占，已通过步骤保留原依据。 */
export function returnStep(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  step: ApprovalStep,
  now: string,
): AuditEvent[] {
  const events: AuditEvent[] = []
  step.status = 'returned'
  step.decidedAt = now
  step.basisReservationId =
    packageItem.activeReservationId ?? step.basisReservationId
  const reservation = state.reservations.find(
    (item) => item.id === packageItem.activeReservationId,
  )
  if (reservation && reservation.status === 'held') {
    releaseReservation(reservation, now, '审批退回，未完成预占释放。')
    events.push({
      packageId: packageItem.id,
      action: '释放预占额度',
      target: packageItem.code,
      operator: step.assignee,
      detail: `预占账 ${reservation.id} 释放 ${reservation.amount}，已通过步骤仍以原批次为依据。`,
    })
  }
  packageItem.status = 'returned'
  packageItem.activeReservationId = undefined
  return events
}

function releaseReservation(
  reservation: QuotaReservation,
  now: string,
  reason: string,
): void {
  reservation.status = 'released'
  reservation.releasedAt = now
  reservation.conflictReason = reason
}

/**
 * 依据变化处理：现行版本、引用版本或技术参数变化后，未完成审批的预占失效并按新版本重算；
 * 已完成审批（settled）保留原依据不动。重算失败（额度被他人抢走）时记冲突并挡住审批。
 */
export function applyBasisChange(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  now: string,
  reason: string,
): AuditEvent[] {
  const events: AuditEvent[] = []
  const held = activeHeldReservation(state, packageItem.id)
  if (!held) return events
  const rule = findApplicableRule(packageItem, state.rules)
  const newBasis = rule ? buildBasis(packageItem, state.files, rule) : held.basis
  if (isSameBasis(held.basis, newBasis) && held.ruleId === rule?.id) return events

  held.status = 'released'
  held.releasedAt = now
  held.conflictReason = `依据变化失效：${reason}`
  packageItem.activeReservationId = undefined
  events.push({
    packageId: packageItem.id,
    action: '预占依据失效',
    target: packageItem.code,
    operator: '当前用户',
    detail: `预占账 ${held.id} 因${reason}失效，释放 ${held.amount}；已完成审批步骤保留原依据。`,
  })

  if (!rule) {
    blockPackage(packageItem, now, '依据变化后未匹配到许可规则，无法重算预占。', 0)
    return events
  }

  const { settled, held: heldTotal } = poolUsage(state.reservations, rule.id)
  const amount = reservationAmount(rule)
  const available = rule.quotaLimit - settled - heldTotal
  if (amount > available) {
    const shortage = amount - available
    const blocker = findBlockingHeld(state, rule.id, packageItem.id)
    const reasonText = `按新版本重算预占时额度不足：可预占 ${available}，需要 ${amount}，缺额 ${shortage}。`
    const conflicted: QuotaReservation = {
      id: uid('res'),
      packageId: packageItem.id,
      ruleId: rule.id,
      round: held.round,
      amount,
      status: 'conflicted',
      basis: newBasis,
      versionToken: crypto.randomUUID(),
      conflictWith: blocker ? blocker.id : undefined,
      conflictReason: reasonText,
      pendingComment: '',
      submittedBy: '系统',
      submittedAt: now,
    }
    state.reservations.push(conflicted)
    packageItem.pendingConflict = {
      reservationId: conflicted.id,
      reason: reasonText,
      comment: '',
      at: now,
    }
    packageItem.status = 'returned'
    events.push({
      packageId: packageItem.id,
      action: '重算预占被阻断',
      target: packageItem.code,
      operator: '系统',
      detail: reasonText,
    })
    return events
  }

  const renewed: QuotaReservation = {
    id: uid('res'),
    packageId: packageItem.id,
    ruleId: rule.id,
    round: held.round,
    amount,
    status: 'held',
    basis: newBasis,
    versionToken: crypto.randomUUID(),
    submittedBy: '系统',
    submittedAt: now,
  }
  state.reservations.push(renewed)
  packageItem.activeReservationId = renewed.id
  packageItem.matchedRuleId = rule.id
  events.push({
    packageId: packageItem.id,
    action: '按新版本重算预占',
    target: packageItem.code,
    operator: '系统',
    detail: `新预占账 ${renewed.id} 按规则「${rule.name}」预占 ${amount}，审批沿原路线继续。`,
  })
  return events
}

function blockPackage(
  packageItem: MaterialPackage,
  now: string,
  reason: string,
  shortage: number,
): void {
  packageItem.status = 'returned'
  packageItem.quotaBlocked = { reason, shortage, at: now }
}

/**
 * 崩溃恢复：把异常退出时保留的 failed 批次重新挂起。
 * 幂等：重复恢复不会产生第二条预占，也不会重复扣减。
 */
export function recoverReservations(state: WorkspaceState, now: string): AuditEvent[] {
  const events: AuditEvent[] = []
  state.reservations
    .filter((item) => item.status === 'failed')
    .forEach((reservation) => {
      const packageItem = state.packages.find((item) => item.id === reservation.packageId)
      if (!packageItem) {
        releaseReservation(reservation, now, '资料包不存在，异常批次关闭。')
        return
      }
      const rule = findApplicableRule(packageItem, state.rules)
      if (!rule) {
        releaseReservation(reservation, now, '恢复时未匹配到许可规则。')
        events.push({
          packageId: packageItem.id,
          action: '异常批次关闭',
          target: packageItem.code,
          operator: '系统',
          detail: `批次 ${reservation.id} 无法匹配规则，已释放。`,
        })
        return
      }
      const currentBasis = buildBasis(packageItem, state.files, rule)
      if (!isSameBasis(reservation.basis, currentBasis)) {
        releaseReservation(reservation, now, '中断期间依据已变化，按恢复流程放弃旧批次。')
        events.push(...applyBasisChange(state, packageItem, now, '中断恢复时检测到版本/参数变化'))
        return
      }
      const { settled, held } = poolUsage(state.reservations, rule.id)
      const available = rule.quotaLimit - settled - held
      if (reservation.amount > available) {
        const blocker = findBlockingHeld(state, rule.id, packageItem.id)
        reservation.status = 'conflicted'
        reservation.conflictWith = blocker?.id
        reservation.conflictReason = `恢复未完成预占时额度不足：可预占 ${available}，需要 ${reservation.amount}，缺额 ${reservation.amount - available}。`
        packageItem.pendingConflict = {
          reservationId: reservation.id,
          reason: reservation.conflictReason,
          comment: reservation.pendingComment ?? '',
          at: now,
        }
        packageItem.status = 'returned'
        events.push({
          packageId: packageItem.id,
          action: '恢复预占受阻',
          target: packageItem.code,
          operator: '系统',
          detail: reservation.conflictReason,
        })
        return
      }
      reservation.status = 'held'
      packageItem.activeReservationId = reservation.id
      packageItem.matchedRuleId = rule.id
      if (!packageItem.approvalRoute.some((step) => step.status === 'active')) {
        packageItem.approvalRoute = mergeRoute(packageItem.approvalRoute, rule.approvalLevel)
      }
      packageItem.currentRound = Math.max(packageItem.currentRound, reservation.round)
      packageItem.status = 'reviewing'
      events.push({
        packageId: packageItem.id,
        action: '恢复未完成预占',
        target: packageItem.code,
        operator: '系统',
        detail: `异常批次 ${reservation.id} 已恢复为 held，预占 ${reservation.amount}；重试未重复扣减。`,
      })
    })
  return events
}

/** 冲突落败者在额度腾出后重提：复用同一批次，成功才占额。 */
export function resubmitConflict(
  state: WorkspaceState,
  reservationId: string,
  now: string,
  comment?: string,
): OperationResult {
  const reservation = state.reservations.find((item) => item.id === reservationId)
  if (!reservation || reservation.status !== 'conflicted') {
    throw new QuotaError('只能重提处于冲突状态的预占批次。')
  }
  const packageItem = state.packages.find((item) => item.id === reservation.packageId)
  if (!packageItem) throw new QuotaError('资料包不存在。')
  const rule = state.rules.find((item) => item.id === reservation.ruleId)
  if (!rule) throw new QuotaError('许可规则不存在。')

  const { settled, held } = poolUsage(state.reservations, rule.id)
  const available = rule.quotaLimit - settled - held
  if (reservation.amount > available) {
    const shortage = reservation.amount - available
    reservation.conflictReason = `重提时仍额度不足：可预占 ${available}，需要 ${reservation.amount}，缺额 ${shortage}。`
    packageItem.pendingConflict = {
      reservationId: reservation.id,
      reason: reservation.conflictReason,
      comment: comment ?? reservation.pendingComment ?? '',
      at: now,
    }
    throw new QuotaError(
      `额度仍然不足，已挡住重提：可预占 ${available}，需要 ${reservation.amount}，缺额 ${shortage}。`,
      { shortage, blocker: reservation.conflictWith },
    )
  }

  const newBasis = buildBasis(packageItem, state.files, rule)
  reservation.status = 'held'
  reservation.basis = newBasis
  reservation.versionToken = crypto.randomUUID()
  reservation.conflictWith = undefined
  reservation.conflictReason = undefined
  reservation.pendingComment = comment ?? reservation.pendingComment
  reservation.submittedAt = now
  packageItem.activeReservationId = reservation.id
  packageItem.pendingConflict = undefined
  packageItem.quotaBlocked = undefined
  packageItem.matchedRuleId = rule.id
  if (!packageItem.approvalRoute.some((step) => step.status === 'active')) {
    packageItem.approvalRoute = mergeRoute(packageItem.approvalRoute, rule.approvalLevel)
  }
  packageItem.status = 'reviewing'
  return {
    reservation,
    events: [
      {
        packageId: packageItem.id,
        action: '冲突批次重提生效',
        target: packageItem.code,
        operator: '当前用户',
        detail: `冲突批次 ${reservation.id} 先到重提生效，预占 ${reservation.amount}。`,
      },
    ],
  }
}

/** 放弃冲突批次（不占额，仅留痕）。 */
export function abandonConflict(
  state: WorkspaceState,
  reservationId: string,
  now: string,
): AuditEvent[] {
  const reservation = state.reservations.find((item) => item.id === reservationId)
  if (!reservation || reservation.status !== 'conflicted') {
    throw new QuotaError('只能放弃处于冲突状态的预占批次。')
  }
  releaseReservation(reservation, now, '申报人放弃冲突批次。')
  const packageItem = state.packages.find((item) => item.id === reservation.packageId)
  if (packageItem?.pendingConflict?.reservationId === reservationId) {
    packageItem.pendingConflict = undefined
  }
  return [
    {
      packageId: reservation.packageId,
      action: '放弃冲突批次',
      target: packageItem?.code ?? reservation.packageId,
      operator: '当前用户',
      detail: `冲突批次 ${reservationId} 已关闭，未占用任何额度。`,
    },
  ]
}

/**
 * 旧数据升级：按当前状态回填额度基线。
 * - approved/licensed/locked：历史已用记 settled；
 * - reviewing/validating：在途部分记 held（baseline，不重复计入 quotaUsed）；
 * - draft/returned：历史已用记 released，只留痕不占额。
 * 历史已用额度不会被重新占用。
 */
export function migrateWorkspace(state: WorkspaceState, now: string): WorkspaceState {
  if (!Array.isArray(state.reservations)) state.reservations = []
  if (state.reservations.length > 0) return state

  state.packages.forEach((packageItem) => {
    const rule = findApplicableRule(packageItem, state.rules)
    if (!rule || packageItem.quotaUsed <= 0) return
    const basis = buildBasis(packageItem, state.files, rule)
    const terminal = ['approved', 'licensed', 'locked'].includes(packageItem.status)
    const inReview = ['reviewing', 'validating'].includes(packageItem.status)
    const status = terminal ? 'settled' : inReview ? 'held' : 'released'
    const reservation: QuotaReservation = {
      id: `res-backfill-${packageItem.id}`,
      packageId: packageItem.id,
      ruleId: rule.id,
      round: packageItem.currentRound,
      amount: packageItem.quotaUsed,
      status: status as QuotaReservation['status'],
      basis,
      versionToken: 'backfill',
      baseline: true,
      submittedBy: '历史数据迁移',
      submittedAt: packageItem.updatedAt || now,
      settledAt: terminal ? packageItem.updatedAt || now : undefined,
      releasedAt: status === 'released' ? packageItem.updatedAt || now : undefined,
      conflictReason: status === 'released' ? '历史数据回填：未占用额度，仅保留已用记录。' : undefined,
    }
    state.reservations.push(reservation)
    if (status === 'held') packageItem.activeReservationId = reservation.id
    if (status === 'settled') {
      // 旧数据中审批已完成且历史已扣额度的包，按“预占转实占后即已许可”对齐状态。
      const allApproved =
        packageItem.approvalRoute.length > 0 &&
        packageItem.approvalRoute.every((step) => step.status === 'approved')
      if (allApproved || packageItem.status === 'licensed' || packageItem.status === 'locked') {
        packageItem.status = 'licensed'
        packageItem.activeReservationId = undefined
      }
    }
  })
  return state
}

export const reservationStatusLabels: Record<QuotaReservation['status'], string> = {
  held: '预占中',
  settled: '已实占',
  released: '已释放',
  conflicted: '冲突未决',
  failed: '写入中断',
}
