import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  MaterialFile,
  MaterialPackage,
  PageReview,
  QuotaBatch,
  QuotaReservation,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import {
  loadWorkspace,
  resetWorkspace,
  saveWorkspace,
} from '@/services/storage'
import {
  QuotaShortfallError,
  activeHold,
  applyHold,
  basisVersionLabel,
  buildBasis,
  confirmHold,
  holdAmountForRule,
  reholdForBasisChange,
  releaseHold,
  syncPackageQuota,
  basisChanged,
} from '@/services/quota'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

// 同一标签页内所有写操作串行，保证“两人同时提交”先到者完整落账后后到者再判额度
let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = writeChain.then(task)
  writeChain = result.catch(() => undefined)
  return result
}

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = (request) =>
  serialize(() => handleRequest(request))

/** 供脚本/测试直接派发本地请求，跳过 RTK 封装 */
export function dispatchMockRequest(request: MockRequest) {
  return serialize(() => handleRequest(request))
}

async function handleRequest({ url, body }: MockRequest): Promise<{ data: unknown } | { error: MockError }> {
  await wait()
  let state = loadWorkspace()
  const payload = (body ?? {}) as Record<string, unknown>
  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }
  const comment = (entry: Omit<ReviewComment, 'id' | 'createdAt'>) => {
    state.comments.unshift({ ...entry, id: `comment-${crypto.randomUUID()}`, createdAt: now() })
  }
  const refreshFindings = () => {
    state.findings = state.packages.flatMap((packageItem) =>
      validatePackage(packageItem, state.files, state.rules, state),
    )
  }

  try {
    if (url === '/workspace') {
      recoverPendingBatches(state)
      saveWorkspace(state)
      return { data: state }
    }

    if (url === '/quota/recover') {
      const recovered = recoverPendingBatches(state)
      saveWorkspace(state)
      return { data: { workspace: state, recovered } }
    }

    if (url === '/package/save') {
      const packageId = String(payload.packageId)
      const patch = payload.patch as Partial<MaterialPackage>
      const current = state.packages.find((item) => item.id === packageId)
      if (!current) throw new Error('资料包不存在')
      const watchKeys = ['category', 'destination', 'technologyTags', 'personnelScopes'] as const
      const beforeSnap = watchKeys.map((key) => JSON.stringify(current[key]))
      Object.assign(current, patch, { updatedAt: now() })
      current.matchedRuleId = findApplicableRule(current, state.rules)?.id
      const changedKey = watchKeys.find((key, index) => JSON.stringify(current[key]) !== beforeSnap[index])
      audit({
        packageId,
        action: '更新资料包',
        target: current.code,
        operator: '当前用户',
        detail: '更新收件方、最终用途、声明或技术参数。',
      })
      if (changedKey) {
        // 技术参数（或影响规则匹配的分类/目的地/人员范围）变化：在途预占按新依据重算
        applyBasisChange(state, current, `技术参数/适用规则字段变化（${changedKey}）`)
      }
      refreshFindings()
    } else if (url === '/package/create') {
      const draft = payload.package as Omit<
        MaterialPackage,
        'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
      >
      const rule = findApplicableRule(
        { ...draft, id: 'temp', approvalRoute: [], versions: [], currentRound: 0, createdAt: '', updatedAt: '' },
        state.rules,
      )
      const packageItem: MaterialPackage = {
        ...draft,
        id: `pkg-${crypto.randomUUID()}`,
        matchedRuleId: rule?.id,
        approvalRoute: [],
        currentRound: 0,
        createdAt: now(),
        updatedAt: now(),
        versions: [],
      }
      packageItem.versions.push({
        id: `version-${crypto.randomUUID()}`,
        label: 'V1.0',
        createdAt: now(),
        createdBy: packageItem.applicant,
        summary: '创建资料包初始版本。',
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: {},
        },
      })
      state.packages.unshift(packageItem)
      audit({
        packageId: packageItem.id,
        action: '创建资料包',
        target: packageItem.code,
        operator: packageItem.applicant,
        detail: `目的地：${packageItem.destination}，资料类型：${packageItem.category}。`,
      })
    } else if (url === '/file/save') {
      const file = payload.file as MaterialFile
      const index = state.files.findIndex((item) => item.id === file.id)
      const existed = index >= 0
      if (existed) state.files[index] = file
      else state.files.push(file)
      if (!existed) {
        const owner = state.packages.find((item) => item.id === file.packageId)
        if (owner) applyBasisChange(state, owner, `新增资料文件「${file.name}」`)
      }
      refreshFindings()
    } else if (url === '/file/version/add') {
      const packageId = String(payload.packageId)
      const fileId = String(payload.fileId)
      const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
      if (!file) throw new Error('文件不存在')
      const pageCount = Number(payload.pageCount)
      const label = String(payload.label)
      const summary = String(payload.summary)
      const newVersion = {
        id: `file-version-${crypto.randomUUID()}`,
        label,
        uploadedAt: now(),
        hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
        sizeKb: pageCount * 96 + 720,
        pages: Array.from({ length: pageCount }, (_, index) => ({
          id: `page-${crypto.randomUUID()}`,
          page: index + 1,
          category: file.kind,
          controlled: false,
          desensitized: false,
          note: '',
          reviewer: '',
        })),
        changeSummary: summary,
      }
      file.versions.push(newVersion)
      file.activeVersionId = newVersion.id
      file.referencedVersionId = newVersion.id
      audit({
        packageId,
        action: '上传文件版本',
        target: `${file.name} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
      const owner = state.packages.find((item) => item.id === packageId)
      if (owner) {
        // 现行版本换版：未完成审批的预占失效并按新版本重算，已完成步骤保留原依据
        applyBasisChange(state, owner, `文件「${file.name}」现行版本换版为 ${label}`)
      }
      refreshFindings()
    } else if (url === '/file/reference') {
      const fileId = String(payload.fileId)
      const versionId = String(payload.versionId)
      const file = state.files.find((item) => item.id === fileId)
      if (!file) throw new Error('文件不存在')
      const previous = file.referencedVersionId
      file.referencedVersionId = versionId
      audit({
        packageId: file.packageId,
        action: '选择引用版本',
        target: file.name,
        operator: '当前用户',
        detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
      })
      const owner = state.packages.find((item) => item.id === file.packageId)
      if (owner && previous !== versionId) {
        applyBasisChange(
          state,
          owner,
          `文件「${file.name}」引用版本切换为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}`,
        )
      }
      refreshFindings()
    } else if (url === '/page/save') {
      const file = state.files.find((item) => item.id === String(payload.fileId))
      const version = file?.versions.find((item) => item.id === String(payload.versionId))
      if (!file || !version) throw new Error('文件版本不存在')
      const page = payload.page as PageReview
      const index = version.pages.findIndex((item) => item.id === page.id)
      if (index >= 0) version.pages[index] = page
      else version.pages.push(page)
      audit({
        packageId: file.packageId,
        action: '逐页分类核对',
        target: `${file.name} 第 ${page.page} 页`,
        operator: page.reviewer || '当前用户',
        detail: page.controlled ? `标记受控，脱敏状态：${page.desensitized ? '已脱敏' : '待脱敏'}` : '标记为一般资料',
      })
    } else if (url === '/package/validate') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      refreshFindings()
      audit({
        packageId,
        action: '执行许可校验',
        target: packageItem.code,
        operator: '当前用户',
        detail: `生成 ${state.findings.filter((item) => item.packageId === packageId).length} 条核对结果（额度口径含预占）。`,
      })
    } else if (url === '/package/version') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const summary = String(payload.summary)
      const label = String(payload.label)
      packageItem.versions.push({
        id: `package-version-${crypto.randomUUID()}`,
        label,
        createdAt: now(),
        createdBy: '当前用户',
        summary,
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: Object.fromEntries(
            state.files
              .filter((file) => file.packageId === packageId)
              .map((file) => [file.id, file.activeVersionId]),
          ),
        },
      })
      audit({
        packageId,
        action: '创建资料包版本',
        target: `${packageItem.code} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
    } else if (url === '/approval/submit') {
      await submitWithHold(state, {
        packageId: String(payload.packageId),
        operator: '当前用户',
        crashPoint: payload.crashPoint as string | undefined,
        audit,
        comment,
      })
      refreshFindings()
    } else if (url === '/quota/rehold') {
      const packageItem = state.packages.find((item) => item.id === String(payload.packageId))
      if (!packageItem) throw new Error('资料包不存在')
      await reholdWithBatch(state, packageItem, payload.crashPoint as string | undefined, audit)
      refreshFindings()
    } else if (url === '/approval/decide') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
      if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
      if (packageItem.status === 'quota-blocked') {
        throw new Error('额度预占已失效且重算额度不足，必须先恢复预占才能继续审批；已通过步骤保留原依据。')
      }
      const hold = activeHold(state, packageId)
      if (!hold) {
        throw new Error('当前在途审批没有有效预占额度，请先恢复预占后再审批。')
      }
      const decision = String(payload.decision)
      step.comment = String(payload.comment ?? '')
      step.decidedAt = now()
      if (decision === 'return') {
        step.status = 'returned'
        packageItem.status = 'returned'
        releaseHold(state, packageId, now(), '审批退回，预占额度释放回池。')
        packageItem.quotaBasis = undefined
        comment({
          packageId,
          author: step.assignee,
          content: `审批退回：${step.comment || '需补正资料'}。预占额度 ${hold.amount} 已释放回池。`,
          round: packageItem.currentRound,
          kind: 'manual',
        })
      } else {
        step.status = 'approved'
        step.basisLabel = `第 ${packageItem.currentRound} 轮`
        step.basisVersionLabel = basisVersionLabel(packageItem.quotaBasis)
        const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
        if (next) next.status = 'active'
        else {
          packageItem.status = 'approved'
          audit({
            packageId,
            action: '全部审批通过',
            target: packageItem.code,
            operator: step.assignee,
            detail: `全部步骤完成，预占 ${hold.amount} 保留至许可确认扣减，不会重复占用。`,
          })
        }
      }
      audit({
        packageId,
        action: decision === 'return' ? '审批退回' : '审批通过',
        target: `${packageItem.code} / ${step.role}`,
        operator: step.assignee,
        detail: step.comment || '无补充意见。',
      })
      refreshFindings()
    } else if (url === '/license/deduct') {
      await deductWithConfirm(state, {
        packageId: String(payload.packageId),
        amount: Number(payload.amount),
        operator: '当前用户',
        crashPoint: payload.crashPoint as string | undefined,
        audit,
      })
      refreshFindings()
    } else if (url === '/quota/concurrent-demo') {
      runConcurrentDemo(state, { audit, comment })
      refreshFindings()
    } else if (url === '/comment/add') {
      const entry = payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>
      comment(entry.kind ? entry : { ...entry, kind: 'manual' })
    } else if (url === '/audit/add') {
      audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
    } else if (url === '/workspace/reset') {
      state = resetWorkspace()
      return { data: state }
    } else {
      throw new Error(`未实现的本地接口：${url}`)
    }

    saveWorkspace(state)
    return { data: state }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : '本地操作失败'
    // 冲突、额度不足、模拟写入异常：副作用（冲突意见、WAL 批次）必须保留完整
    if (error instanceof QuotaShortfallError || error instanceof PersistableError) {
      try {
        saveWorkspace(state)
      } catch {
        // 保存本身模拟崩溃时，批次此前已落盘
      }
    }
    return {
      error: {
        status: 400,
        error: messageText,
      },
    }
  }
}

/** 已落副作用、需要持久化后再报错给调用方 */
class PersistableError extends Error {}

interface AuditApi {
  audit: (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => void
  comment: (entry: Omit<ReviewComment, 'id' | 'createdAt'>) => void
}

function startBatch(
  state: WorkspaceState,
  input: Pick<QuotaBatch, 'type' | 'ruleId' | 'packageId' | 'round' | 'amount' | 'reservationId' | 'basis' | 'note'>,
): QuotaBatch {
  const batch: QuotaBatch = {
    ...input,
    id: `batch-${crypto.randomUUID()}`,
    status: 'pending',
    createdAt: now(),
    updatedAt: now(),
  }
  state.batches.unshift(batch)
  return batch
}

/** 依据变化（现行版本/引用版本/技术参数）后在途预占失效、按新版本重算 */
function applyBasisChange(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  reason: string,
): void {
  if (packageItem.status === 'licensed' || packageItem.status === 'locked') return
  const hasHold = Boolean(activeHold(state, packageItem.id))
  if (!hasHold && packageItem.status !== 'quota-blocked') return
  const rule = findApplicableRule(packageItem, state.rules)
  if (!rule) {
    releaseHold(state, packageItem.id, now(), `依据变化（${reason}）后规则失配，预占作废。`)
    packageItem.status = 'quota-blocked'
    packageItem.quotaBasis = undefined
    return
  }
  const basis = buildBasis(packageItem, rule, state.files, packageItem.currentRound)
  if (!basisChanged(packageItem.quotaBasis, basis) && hasHold) return
  try {
    reholdForBasisChange({
      state,
      rule,
      packageItem,
      basis,
      reason,
      nowText: now(),
    })
    if (packageItem.status === 'quota-blocked') packageItem.status = 'reviewing'
    state.comments.unshift({
      id: `comment-${crypto.randomUUID()}`,
      packageId: packageItem.id,
      author: '预占台账',
      content: `依据变化：${reason}。未完成审批的原预占已作废，已按新依据（${basisVersionLabel(basis)}）重算预占 ${holdAmountForRule(rule)}；已通过步骤保留原依据，额度未重复占用。`,
      createdAt: now(),
      round: packageItem.currentRound,
      kind: 'basis',
    })
    state.audit.unshift({
      id: `audit-${crypto.randomUUID()}`,
      packageId: packageItem.id,
      action: '预占重算',
      target: packageItem.code,
      operator: '系统',
      detail: `${reason}；旧预占作废，按规则「${rule.name}」上限重新预占 ${holdAmountForRule(rule)}。`,
      createdAt: now(),
    })
  } catch (error) {
    packageItem.status = 'quota-blocked'
    packageItem.quotaBasis = undefined
    const shortfall = error instanceof QuotaShortfallError ? `，缺额 ${error.shortfall}` : ''
    state.comments.unshift({
      id: `comment-${crypto.randomUUID()}`,
      packageId: packageItem.id,
      author: '预占台账',
      content: `依据变化：${reason}。原预占已失效，按新依据重算时额度不足${shortfall}，审批被挡住；请等待额度释放后恢复预占。已通过步骤保留原依据。`,
      createdAt: now(),
      round: packageItem.currentRound,
      kind: 'basis',
    })
    state.audit.unshift({
      id: `audit-${crypto.randomUUID()}`,
      packageId: packageItem.id,
      action: '预占重算受阻',
      target: packageItem.code,
      operator: '系统',
      detail: `${reason}；旧预占已作废，新预占额度不足${shortfall}，资料包转入待恢复预占。`,
      createdAt: now(),
    })
  }
}

/** 提交审批：按规则上限预占，全程 WAL 批次，额度不足/冲突挡住提交 */
async function submitWithHold(
  state: WorkspaceState,
  options: { packageId: string; operator: string; crashPoint?: string; audit: AuditApi['audit']; comment: AuditApi['comment'] },
): Promise<void> {
  const { packageId, operator, crashPoint, audit, comment } = options
  const packageItem = state.packages.find((item) => item.id === packageId)
  if (!packageItem) throw new Error('资料包不存在')
  const highFindings = state.findings.filter(
    (item) => item.packageId === packageId && item.level === 'high',
  )
  if (highFindings.length) {
    throw new PersistableError(`存在 ${highFindings.length} 项高风险核对项，请先修复后提交`)
  }
  if (packageItem.status === 'quota-blocked') {
    throw new PersistableError('预占已失效待恢复，请先“恢复预占”再提交审批。')
  }
  if (activeHold(state, packageId)) {
    throw new PersistableError('该资料包已有有效预占，审批进行中，请勿重复提交。')
  }
  const rule = findApplicableRule(packageItem, state.rules)
  if (!rule) throw new Error('未匹配到许可规则')
  const round = packageItem.currentRound + 1
  const basis = buildBasis(packageItem, rule, state.files, round)
  const amount = holdAmountForRule(rule)
  const reservationId = `hold-${crypto.randomUUID()}`
  const batch = startBatch(state, {
    type: 'submit-hold',
    ruleId: rule.id,
    packageId,
    round,
    amount,
    reservationId,
    basis,
    note: `提交审批，按规则「${rule.name}」上限预占 ${amount}`,
  })

  // WAL：批次先完整落盘，再执行预占
  saveWorkspace(state)
  if (crashPoint === 'before-hold') {
    // 模拟写入异常退出：批次已完整保留，预占未执行
    throw new PersistableError('模拟写入异常退出：提交批次已完整落盘，预占尚未执行。刷新后可恢复，重试不重复扣减。')
  }

  let reservation: QuotaReservation
  try {
    reservation = applyHold({
      state,
      rule,
      packageItem,
      basis,
      reason: `第 ${round} 轮提交审批预占（规则上限整池）`,
      nowText: now(),
      batchId: batch.id,
      reservationId,
    })
  } catch (error) {
    batch.status = 'failed'
    batch.updatedAt = now()
    if (error instanceof QuotaShortfallError) {
      recordHoldFailure(state, { packageId, ruleId: rule.id, round, amount, error, batch, comment })
      saveWorkspace(state)
      throw new PersistableError(error.message)
    }
    throw error
  }

  if (crashPoint === 'after-hold-save') {
    saveWorkspace(state)
    throw new PersistableError('模拟写入异常退出：预占已落账，路线尚未更新，刷新后可恢复。')
  }

  packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
  packageItem.matchedRuleId = rule.id
  packageItem.status = 'reviewing'
  packageItem.currentRound = round
  packageItem.quotaBasis = basis
  syncPackageQuota(state, packageItem)
  batch.status = 'committed'
  batch.updatedAt = now()
  audit({
    packageId,
    action: '提交审批',
    target: packageItem.code,
    operator,
    detail: `按 ${rule.name} 生成审批路线（第 ${round} 轮），同步预占额度 ${reservation.amount}（整池互斥），依据：${basisVersionLabel(basis)}。`,
  })
}

/** 待恢复预占资料包显式重算（同样走 WAL 批次，重试不重复扣减） */
async function reholdWithBatch(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  crashPoint: string | undefined,
  audit: AuditApi['audit'],
): Promise<void> {
  const rule = findApplicableRule(packageItem, state.rules)
  if (!rule) throw new Error('未匹配到许可规则')
  const round = packageItem.currentRound || 1
  const basis = buildBasis(packageItem, rule, state.files, round)
  const amount = holdAmountForRule(rule)
  const reservationId = `hold-${crypto.randomUUID()}`
  const batch = startBatch(state, {
    type: 'rehold',
    ruleId: rule.id,
    packageId: packageItem.id,
    round,
    amount,
    reservationId,
    basis,
    note: `依据变化后恢复预占 ${amount}`,
  })
  saveWorkspace(state)
  if (crashPoint === 'before-hold') {
    throw new PersistableError('模拟写入异常退出：恢复批次已完整落盘，预占尚未执行。刷新后可恢复，重试不重复扣减。')
  }
  let reservation: QuotaReservation
  try {
    reservation = applyHold({
      state,
      rule,
      packageItem,
      basis,
      reason: `第 ${round} 轮依据变化后恢复预占`,
      nowText: now(),
      batchId: batch.id,
      reservationId,
    })
  } catch (error) {
    batch.status = 'failed'
    batch.updatedAt = now()
    if (error instanceof QuotaShortfallError) {
      throw new PersistableError(error.message)
    }
    throw error
  }
  packageItem.quotaBasis = basis
  if (packageItem.status === 'quota-blocked') packageItem.status = 'reviewing'
  batch.status = 'committed'
  batch.updatedAt = now()
  audit({
    packageId: packageItem.id,
    action: '恢复预占',
    target: packageItem.code,
    operator: '当前用户',
    detail: `按新依据（${basisVersionLabel(basis)}）预占 ${reservation.amount}，可继续未完成审批。`,
  })
}

/** 许可确认扣减：held 转 confirmed，WAL 批次保证重试不重复扣减 */
async function deductWithConfirm(
  state: WorkspaceState,
  options: { packageId: string; amount: number; operator: string; crashPoint?: string; audit: AuditApi['audit'] },
): Promise<void> {
  const { packageId, amount, operator, crashPoint, audit } = options
  const packageItem = state.packages.find((item) => item.id === packageId)
  if (!packageItem) throw new Error('资料包不存在')
  if (packageItem.status !== 'approved') {
    throw new Error('只有全部审批步骤完成（已批准待许可）后才允许确认扣减额度。')
  }
  const highFindings = state.findings.filter(
    (item) => item.packageId === packageId && item.level === 'high',
  )
  if (highFindings.length) throw new Error('存在高风险核对项，系统拒绝确认扣减额度。')
  const hold = activeHold(state, packageId)
  if (!hold) throw new Error('缺少有效预占，无法确认扣减，请重新提交审批。')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('扣减额度必须大于 0。')
  if (amount > hold.amount) {
    throw new Error(`确认扣减 ${amount} 超出预占额度 ${hold.amount}。`)
  }
  const batch = startBatch(state, {
    type: 'deduct-confirm',
    ruleId: hold.ruleId,
    packageId,
    round: hold.round,
    amount,
    reservationId: hold.id,
    basis: hold.basis,
    note: `确认扣减 ${amount}，预占 ${hold.amount} 中剩余释放回池`,
  })
  saveWorkspace(state)
  if (crashPoint === 'after-batch-save') {
    throw new PersistableError('模拟写入异常退出：扣减批次已落盘，尚未确认，刷新后自动恢复且不重复扣减。')
  }
  confirmHold({ state, reservation: hold, amount, nowText: now() })
  packageItem.status = 'licensed'
  syncPackageQuota(state, packageItem)
  batch.status = 'committed'
  batch.updatedAt = now()
  audit({
    packageId,
    action: '确认扣减许可额度',
    target: packageItem.code,
    operator,
    detail: `确认扣减 ${amount}，预占剩余 ${hold.amount - amount} 释放回池，累计已确认 ${packageItem.quotaUsed}/${packageItem.quotaLimit}。`,
  })
}

/** 两人同时提交：队列内先到者得额度，后到者留意见与冲突 */
function runConcurrentDemo(state: WorkspaceState, api: AuditApi): void {
  const rule = state.rules.find((item) => item.id === 'rule-my-general')
  if (!rule) throw new Error('演示规则不存在')
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const makeDraft = (seq: number): MaterialPackage => ({
    id: `pkg-demo-${Date.now()}-${seq}`,
    code: `EC-CONC-${String(Date.now()).slice(-5)}-${seq}`,
    title: `并发抢额演示 ${seq}（${stamp}）`,
    category: 'technical',
    applicant: seq === 1 ? '申请人甲（先到）' : '申请人乙（后到）',
    recipient: `Concurrent Demo Recipient ${seq}`,
    destination: '马来西亚',
    endUse: '并发预占演示',
    technologyTags: [],
    personnelScopes: [],
    declarations: ['最终用户声明', '最终用途声明'],
    status: 'draft',
    matchedRuleId: rule.id,
    approvalRoute: [],
    currentRound: 0,
    quotaUsed: 0,
    quotaLimit: rule.quotaLimit,
    createdAt: now(),
    updatedAt: now(),
    versions: [],
  })
  const draftA = makeDraft(1)
  const draftB = makeDraft(2)
  state.packages.unshift(draftB, draftA)
  refreshFindingsWithin(state)

  // 第一次提交：先到者
  submitWithHoldSync(state, draftA.id, '申请人甲（先到）', api)
  // 第二次提交：后到者必被挡，留意见与冲突（不抛出中断整个演示）
  try {
    submitWithHoldSync(state, draftB.id, '申请人乙（后到）', api)
  } catch (error) {
    // recordHoldFailure 已在批次失败路径落冲突与意见
    if (!(error instanceof QuotaShortfallError) && !(error instanceof PersistableError)) throw error
  }
}

function refreshFindingsWithin(state: WorkspaceState): void {
  state.findings = state.packages.flatMap((packageItem) =>
    validatePackage(packageItem, state.files, state.rules, state),
  )
}

/** 并发演示用：与 submitWithHold 同规则，但不支持崩溃注入、不异步 */
function submitWithHoldSync(
  state: WorkspaceState,
  packageId: string,
  operator: string,
  api: AuditApi,
): void {
  const packageItem = state.packages.find((item) => item.id === packageId)!
  const rule = findApplicableRule(packageItem, state.rules)!
  const round = packageItem.currentRound + 1
  const basis = buildBasis(packageItem, rule, state.files, round)
  const amount = holdAmountForRule(rule)
  const reservationId = `hold-${crypto.randomUUID()}`
  const batch = startBatch(state, {
    type: 'submit-hold',
    ruleId: rule.id,
    packageId,
    round,
    amount,
    reservationId,
    basis,
    note: `并发演示提交，按规则上限预占 ${amount}`,
  })
  let reservation: QuotaReservation
  try {
    reservation = applyHold({
      state,
      rule,
      packageItem,
      basis,
      reason: `并发演示第 ${round} 轮预占`,
      nowText: now(),
      batchId: batch.id,
      reservationId,
    })
  } catch (error) {
    batch.status = 'failed'
    batch.updatedAt = now()
    if (error instanceof QuotaShortfallError) {
      recordHoldFailure(state, { packageId, ruleId: rule.id, round, amount, error, batch, comment: api.comment })
      throw new PersistableError(error.message)
    }
    throw error
  }
  packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
  packageItem.matchedRuleId = rule.id
  packageItem.status = 'reviewing'
  packageItem.currentRound = round
  packageItem.quotaBasis = basis
  syncPackageQuota(state, packageItem)
  batch.status = 'committed'
  batch.updatedAt = now()
  api.audit({
    packageId,
    action: '并发提交预占',
    target: packageItem.code,
    operator,
    detail: `同时提交中的先到窗口，已按规则上限预占 ${reservation.amount}。`,
  })
}

function recordHoldFailure(
  state: WorkspaceState,
  input: {
    packageId: string
    ruleId: string
    round: number
    amount: number
    error: QuotaShortfallError
    batch: QuotaBatch

    comment: AuditApi['comment']
  },
): void {
  const { packageId, ruleId, round, amount, error, batch, comment } = input
  const competitor = state.reservations.find(
    (item) => item.ruleId === ruleId && item.status === 'held' && item.packageId !== packageId,
  )
  const winner = competitor
    ? state.packages.find((item) => item.id === competitor.packageId)
    : undefined
  if (competitor) {
    state.conflicts.unshift({
      id: `conflict-${crypto.randomUUID()}`,
      ruleId,
      packageId,
      competitorPackageId: competitor.packageId,
      winnerPackageId: competitor.packageId,
      round,
      requested: amount,
      available: error.available,
      shortfall: error.shortfall,
      winnerBatchId: competitor.sourceBatchId,
      loserBatchId: batch.id,
      reason: `两人同时提交，先到者 ${winner?.code ?? competitor.packageId} 已预占整池额度。`,
      createdAt: now(),
    })
  }
  comment({
    packageId,
    author: '预占台账',
    content: competitor
      ? `并发提交冲突：${winner?.code ?? '另一资料包'} 的审批窗口先到，已预占规则全部额度（${amount}），本次提交被挡住，缺额 ${error.shortfall}。待对方释放额度后可重新提交。`
      : `额度不足：本次需预占 ${amount}，当前可用 ${error.available}，缺额 ${error.shortfall}，提交已挡住。`,
    round,
    kind: competitor ? 'conflict' : 'basis',
  })
  state.audit.unshift({
    id: `audit-${crypto.randomUUID()}`,
    packageId,
    action: competitor ? '并发预占冲突' : '预占额度不足',
    target: state.packages.find((item) => item.id === packageId)?.code ?? packageId,
    operator: '系统',
    detail: competitor
      ? `先到者 ${winner?.code ?? competitor.packageId} 占用整池，后到者缺额 ${error.shortfall}，批次 ${batch.id} 失败并留痕。`
      : `需预占 ${amount}，可用 ${error.available}，缺额 ${error.shortfall}，批次 ${batch.id} 失败。`,
    createdAt: now(),
  })
}

/**
 * 启动/手动恢复未完成批次：幂等——预占已存在则不重复建，确认已落则不重复扣。
 */
function recoverPendingBatches(state: WorkspaceState): string[] {
  const notes: string[] = []
  const pending = state.batches.filter((item) => item.status === 'pending')
  pending.forEach((batch) => {
    const packageItem = state.packages.find((item) => item.id === batch.packageId)
    const rule = state.rules.find((item) => item.id === batch.ruleId)
    if (!packageItem || !rule) {
      batch.status = 'failed'
      batch.updatedAt = now()
      return
    }
    try {
      if (batch.type === 'submit-hold' || batch.type === 'rehold') {
        let reservation = batch.reservationId
          ? state.reservations.find((item) => item.id === batch.reservationId)
          : undefined
        if (reservation && reservation.status !== 'held') reservation = undefined
        if (!reservation) {
          reservation = applyHold({
            state,
            rule,
            packageItem,
            basis: batch.basis ?? buildBasis(packageItem, rule, state.files, batch.round),
            reason: `批次恢复预占（${batch.note}）`,
            nowText: now(),
            batchId: batch.id,
            reservationId: batch.reservationId,
          })
        }
        packageItem.quotaBasis = reservation.basis
        if (batch.type === 'submit-hold') {
          if (packageItem.status !== 'reviewing') packageItem.status = 'reviewing'
          if (packageItem.currentRound < batch.round) packageItem.currentRound = batch.round
          if (!packageItem.approvalRoute.some((step) => step.status === 'active' || step.status === 'approved')) {
            packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
          }
        } else if (packageItem.status === 'quota-blocked') {
          packageItem.status = 'reviewing'
        }
        syncPackageQuota(state, packageItem)
        notes.push(`资料包 ${packageItem.code} 的预占批次已恢复（${reservation.amount}），未重复扣减。`)
      } else if (batch.type === 'deduct-confirm') {
        const reservation = state.reservations.find((item) => item.id === batch.reservationId)
        const amount = batch.amount ?? 0
        if (!reservation) {
          batch.status = 'failed'
          batch.updatedAt = now()
          notes.push(`资料包 ${packageItem.code} 的扣减批次找不到预占记录，已置失败，请人工核对。`)
          return
        }
        if (reservation.status === 'held') {
          confirmHold({ state, reservation, amount, nowText: now() })
        }
        packageItem.status = 'licensed'
        syncPackageQuota(state, packageItem)
        notes.push(`资料包 ${packageItem.code} 的扣减批次已恢复，确认 ${amount}，未重复扣减。`)
      }
      batch.status = 'committed'
      batch.updatedAt = now()
      state.audit.unshift({
        id: `audit-${crypto.randomUUID()}`,
        packageId: packageItem.id,
        action: '批次恢复',
        target: packageItem.code,
        operator: '系统',
        detail: `异常退出后的未完成批次 ${batch.id}（${batch.type}）已幂等恢复。`,
        createdAt: now(),
      })
    } catch (error) {
      // 恢复时仍额度不足：批次保持 pending，不重复占用，等额度释放后再次恢复
      const shortfall = error instanceof QuotaShortfallError ? `，缺额 ${error.shortfall}` : ''
      state.audit.unshift({
        id: `audit-${crypto.randomUUID()}`,
        packageId: packageItem.id,
        action: '批次恢复待额度',
        target: packageItem.code,
        operator: '系统',
        detail: `批次 ${batch.id} 恢复时额度仍不足${shortfall}，保留完整批次，稍后重试，不会重复扣减。`,
        createdAt: now(),
      })
    }
  })
  if (notes.length) {
    state.findings = state.packages.flatMap((packageItem) =>
      validatePackage(packageItem, state.files, state.rules, state),
    )
  }
  return notes
}

export const workspaceApi = createApi({
  reducerPath: 'workspaceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    getWorkspace: builder.query<WorkspaceState, void>({
      query: () => ({ url: '/workspace', method: 'GET' }),
      providesTags: ['Workspace'],
    }),
    savePackage: builder.mutation<
      WorkspaceState,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceState,
      {
        package: Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
      }
    >({
      query: (body) => ({ url: '/package/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    saveFile: builder.mutation<WorkspaceState, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<
      WorkspaceState,
      { packageId: string; crashPoint?: 'before-hold' | 'after-hold-save' }
    >({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    reholdQuota: builder.mutation<
      WorkspaceState,
      { packageId: string; crashPoint?: 'before-hold' }
    >({
      query: (body) => ({ url: '/quota/rehold', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceState,
      { packageId: string; stepId: string; decision: 'approve' | 'return'; comment: string }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    deductQuota: builder.mutation<
      WorkspaceState,
      { packageId: string; amount: number; crashPoint?: 'after-batch-save' }
    >({
      query: (body) => ({ url: '/license/deduct', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    recoverBatches: builder.mutation<
      { workspace: WorkspaceState; recovered: string[] },
      void
    >({
      query: () => ({ url: '/quota/recover', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
    concurrentDemo: builder.mutation<WorkspaceState, void>({
      query: () => ({ url: '/quota/concurrent-demo', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
    addComment: builder.mutation<
      WorkspaceState,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceState,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceState, void>({
      query: () => ({ url: '/workspace/reset', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
  }),
})

export const {
  useGetWorkspaceQuery,
  useSavePackageMutation,
  useCreatePackageMutation,
  useSaveFileMutation,
  useAddFileVersionMutation,
  useSetReferenceVersionMutation,
  useSavePageReviewMutation,
  useValidatePackageMutation,
  useCreatePackageVersionMutation,
  useSubmitApprovalMutation,
  useReholdQuotaMutation,
  useDecideApprovalMutation,
  useDeductQuotaMutation,
  useRecoverBatchesMutation,
  useConcurrentDemoMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi
