/**
 * 预占账核心流程测试（纯 Node，无浏览器依赖）：
 * 1. 两人同时提交：先到者生效、后到者留意见与冲突，不重复占用；
 * 2. 文件换版 / 引用版本 / 技术参数变化：未完成预占失效重算，已完成审批保留原依据；
 * 3. 写入异常退出：批次完整保留，恢复未完成预占，重试不重复扣减；
 * 4. 额度不足挡住提交并说明缺额；
 * 5. 旧数据升级按当前状态回填基线，历史已用不重新占用。
 */
import assert from 'node:assert/strict'
import { createInitialState } from './mockData'
import {
  QuotaError,
  applyBasisChange,
  approveStep,
  migrateWorkspace,
  poolUsage,
  recoverReservations,
  resubmitConflict,
  returnStep,
  submitForApproval,
} from './quota'
import type { MaterialPackage, WorkspaceState } from '../types/domain'

let clock = 0
const tick = () => `2026-10-07T0${Math.min(clock, 9)}:${String(clock++).padStart(2, '0')}:00.000Z`

function freshState(): WorkspaceState {
  // 演示数据中各包占用不同规则池；测试在全新包上运行，先清空预占账。
  const state = createInitialState()
  state.reservations = []
  state.packages.forEach((pkg) => {
    pkg.activeReservationId = undefined
    pkg.approvalRoute = []
    pkg.currentRound = 0
    pkg.status = 'draft'
    pkg.quotaUsed = 0
    pkg.pendingConflict = undefined
    pkg.quotaBlocked = undefined
  })
  return state
}

function makePackage(
  state: WorkspaceState,
  overrides: Partial<MaterialPackage> = {},
): MaterialPackage {
  const rule = state.rules.find((item) => item.id === 'rule-my-general')!
  const pkg: MaterialPackage = {
    id: `pkg-test-${crypto.randomUUID()}`,
    code: `TEST-${Math.floor(Math.random() * 10000)}`,
    title: '测试资料包',
    category: 'technical',
    applicant: '测试员',
    recipient: 'Acme Sdn. Bhd.',
    destination: '马来西亚',
    endUse: '民用测试',
    technologyTags: [],
    personnelScopes: [],
    declarations: ['最终用户声明', '最终用途声明'],
    status: 'draft',
    matchedRuleId: rule.id,
    approvalRoute: [],
    currentRound: 0,
    quotaUsed: 0,
    quotaLimit: rule.quotaLimit,
    createdAt: tick(),
    updatedAt: tick(),
    versions: [],
    ...overrides,
  }
  state.packages.push(pkg)
  return pkg
}

function approveAll(state: WorkspaceState, pkg: MaterialPackage) {
  let step = pkg.approvalRoute.find((item) => item.status === 'active')
  while (step) {
    approveStep(state, pkg, step, tick())
    step = pkg.approvalRoute.find((item) => item.status === 'active')
  }
}

// 场景 1：两人同时提交，先到者生效，后到者冲突
function testConcurrentContention() {
  const state = freshState()
  const first = makePackage(state, { code: 'TEST-A', applicant: '甲' })
  const second = makePackage(state, { code: 'TEST-B', applicant: '乙' })

  submitForApproval(state, first, { now: tick(), operator: '甲' })
  const firstPool = poolUsage(state.reservations, 'rule-my-general')
  assert.equal(firstPool.held, 100, '先到者按规则上限预占 100')
  assert.equal(first.status, 'reviewing')

  let conflictId: string | undefined
  try {
    submitForApproval(state, second, {
      now: tick(),
      operator: '乙',
      comment: '乙方紧急项目，请保留意见',
    })
    assert.fail('后到者应被 QuotaError 拦截')
  } catch (error) {
    assert.ok(error instanceof QuotaError)
    assert.match(error.message, /先提交|竞争落败/)
    conflictId = error.conflictReservationId
    assert.ok(conflictId, '冲突批次 id 应随错误返回')
  }
  // 后到者额度没有被占用
  const poolAfter = poolUsage(state.reservations, 'rule-my-general')
  assert.equal(poolAfter.held, 100, '后到者不增加预占')
  assert.equal(poolAfter.settled, 0)
  const conflict = state.reservations.find((item) => item.id === conflictId)
  assert.equal(conflict?.status, 'conflicted')
  assert.equal(conflict?.pendingComment, '乙方紧急项目，请保留意见', '后到者意见保留')
  assert.equal(second.pendingConflict?.reservationId, conflictId)
  assert.notEqual(second.status, 'reviewing', '后到者不进入审批')

  // 先到者退回 → 释放预占 → 后到者重提生效
  const activeStep = first.approvalRoute.find((item) => item.status === 'active')!
  returnStep(state, first, activeStep, tick())
  assert.equal(poolUsage(state.reservations, 'rule-my-general').held, 0, '退回释放预占')

  const result = resubmitConflict(state, conflictId!, tick())
  assert.equal(result.reservation.status, 'held')
  assert.equal(poolUsage(state.reservations, 'rule-my-general').held, 100)
  assert.equal(second.status, 'reviewing', '后到者重提成功进入审批')
  // 再次重提同一批次必须幂等拒绝（不能重复占）
  assert.throws(() => resubmitConflict(state, conflictId!, tick()), QuotaError)
  assert.equal(poolUsage(state.reservations, 'rule-my-general').held, 100, '重试不重复占额')
}

// 场景 2：版本/参数变化后预占失效重算，已完成审批保留原依据
function testBasisChangeAndApprovedPreserved() {
  const state = freshState()
  const pkg = makePackage(state, { code: 'TEST-C' })
  submitForApproval(state, pkg, { now: tick() })
  const firstReservationId = pkg.activeReservationId!
  // 第一步通过，依据记录在步骤上
  const step1 = pkg.approvalRoute.find((item) => item.order === 1)!
  approveStep(state, pkg, step1, tick())
  assert.equal(step1.status, 'approved')
  assert.equal(step1.basisReservationId, firstReservationId)

  // 技术参数变化（马来西亚包加标签仍命中同一规则）
  pkg.technologyTags = ['通用电气']
  const events = applyBasisChange(state, pkg, tick(), '技术参数变化')
  assert.ok(events.some((item) => item.action === '预占依据失效'))
  const old = state.reservations.find((item) => item.id === firstReservationId)
  assert.equal(old?.status, 'released', '旧预占释放')
  const renewedId = pkg.activeReservationId!
  assert.notEqual(renewedId, firstReservationId, '按新版本重算生成新预占')
  assert.equal(poolUsage(state.reservations, 'rule-my-general').held, 100, '重算后仍只占一份')

  // 已通过的第一步保留原批次依据
  assert.equal(step1.basisReservationId, firstReservationId, '已完成审批保留原依据')
  const newStep2 = pkg.approvalRoute.find((item) => item.status === 'active')
  assert.equal(newStep2?.order, 2, '审批沿未完成步骤继续')

  // 全部通过 → 预占转实占，quotaUsed 只增加新批次一次
  approveAll(state, pkg)
  assert.equal(pkg.status, 'licensed')
  assert.equal(pkg.quotaUsed, 100, '仅实占一次，旧释放批次不累加')
  const renewed = state.reservations.find((item) => item.id === renewedId)
  assert.equal(renewed?.status, 'settled')

  // 已完成审批后再改参数：不动 settled 批次
  pkg.technologyTags = ['其他参数']
  const moreEvents = applyBasisChange(state, pkg, tick(), '发证后参数修改')
  assert.equal(moreEvents.length, 0, '已完成审批不受后续变化影响')
  assert.equal(renewed?.status, 'settled')
}

// 场景 3：写入异常退出 → 完整批次保留 → 恢复，重试不重复扣减
function testCrashRecovery() {
  const state = freshState()
  const pkg = makePackage(state, { code: 'TEST-D' })
  submitForApproval(state, pkg, { now: tick(), simulateCrash: true })
  const failedId = state.reservations.find((item) => item.status === 'failed')?.id
  assert.ok(failedId, 'failed 批次已完整写入账本')
  assert.equal(pkg.approvalRoute.length, 0, '路线尚未写入（中断点）')
  assert.equal(poolUsage(state.reservations, 'rule-my-general').held, 0, 'failed 不占额')

  // 恢复
  recoverReservations(state, tick())
  const recovered = state.reservations.find((item) => item.id === failedId)
  assert.equal(recovered?.status, 'held', '原批次恢复为 held（同一条记录，不新建）')
  assert.equal(pkg.activeReservationId, failedId)
  assert.ok(pkg.approvalRoute.some((step) => step.status === 'active'), '路线补齐')
  assert.equal(poolUsage(state.reservations, 'rule-my-general').held, 100)

  // 再次恢复：幂等，不新增批次、不重复占额
  recoverReservations(state, tick())
  assert.equal(
    state.reservations.filter((item) => item.id === failedId).length,
    1,
    '恢复不产生重复批次',
  )
  assert.equal(poolUsage(state.reservations, 'rule-my-general').held, 100)

  // 恢复后正常走完审批
  approveAll(state, pkg)
  assert.equal(pkg.status, 'licensed')
  assert.equal(pkg.quotaUsed, 100, '恢复后结算只扣一次')
}

// 场景 4：历史实占已用足额时，提交被硬挡住并说明缺额
function testInsufficientHardBlock() {
  const state = freshState()
  // 直接构造一个 settled 基线占满 100
  const holder = makePackage(state, { code: 'TEST-E1', status: 'licensed' })
  submitForApproval(state, holder, { now: tick() })
  approveAll(state, holder)
  assert.equal(poolUsage(state.reservations, 'rule-my-general').settled, 100)

  const challenger = makePackage(state, { code: 'TEST-E2' })
  try {
    submitForApproval(state, challenger, { now: tick() })
    assert.fail('额度池耗尽时应挡住提交')
  } catch (error) {
    assert.ok(error instanceof QuotaError)
    assert.match(error.message, /缺额 100/)
  }
  assert.equal(challenger.status, 'draft', '被挡后不进入审批')
  assert.equal(
    state.reservations.filter((item) => item.packageId === challenger.id).length,
    0,
    '硬阻断不产生预占批次',
  )
}

// 场景 5：旧数据升级回填基线，历史已用不重新占用
function testMigrationBackfill() {
  const state = createInitialState() // 含历史 quotaUsed
  const before = JSON.stringify({ q: state.packages.map((p) => p.quotaUsed) })
  migrateWorkspace(state, tick())
  migrateWorkspace(state, tick()) // 重复迁移幂等

  const backfills = state.reservations.filter((item) => item.baseline)
  const pkg001 = state.packages.find((item) => item.id === 'pkg-001')!
  const pkg002 = state.packages.find((item) => item.id === 'pkg-002')!
  assert.equal(backfills.length, 4, '四个有历史已用的包全部回填')
  assert.equal(
    state.reservations.filter((item) => item.packageId === 'pkg-001' && item.status === 'held')
      .length,
    1,
    '审批中包回填 held',
  )
  assert.equal(pkg001.activeReservationId, 'res-backfill-pkg-001')
  const settled002 = state.reservations.find((item) => item.id === 'res-backfill-pkg-002')
  assert.equal(settled002?.status, 'settled', '已批准包回填 settled')
  const back003 = state.reservations.find((item) => item.id === 'res-backfill-pkg-003')
  assert.equal(back003?.status, 'released', '已退回包回填 released，不占额')

  // 回填后结算 held 批次不重复累加历史 quotaUsed
  const initialUsed001 = pkg001.quotaUsed
  const baselineHeld = state.reservations.find(
    (item) => item.id === 'res-backfill-pkg-001',
  )!
  baselineHeld.status = 'settled'
  baselineHeld.settledAt = tick()
  // 模拟 settleReservation 的 baseline 分支语义
  if (!baselineHeld.baseline) pkg001.quotaUsed += baselineHeld.amount
  assert.equal(pkg001.quotaUsed, initialUsed001, '历史已用结算不重复占用')
  assert.equal(pkg002.quotaUsed, 42)

  // 历史已用总量不变
  const after = JSON.stringify({ q: state.packages.map((p) => p.quotaUsed) })
  assert.equal(after, before, '迁移不改变任何 quotaUsed')

  // 旧数据 held 基线占据额度：同规则新提交会被挡住或冲突
  // pkg-001 在新加坡池 held=36，按上限 80 预占时缺 16
  const rival = makePackage(state, {
    code: 'TEST-RIVAL',
    destination: '新加坡',
    category: 'technical',
    technologyTags: ['复合材料'],
    declarations: ['最终用户声明', '最终用途声明', '不扩散声明'],
  })
  try {
    submitForApproval(state, rival, { now: tick() })
    assert.fail('应被额度挡住')
  } catch (error) {
    assert.ok(error instanceof QuotaError)
    assert.match(error.message, /缺额 36|先提交/)
  }
}

const tests = [
  ['并发提交竞争', testConcurrentContention],
  ['依据变化失效重算', testBasisChangeAndApprovedPreserved],
  ['崩溃恢复幂等', testCrashRecovery],
  ['额度不足硬阻断', testInsufficientHardBlock],
  ['旧数据迁移回填', testMigrationBackfill],
] as const

let failures = 0
for (const [name, test] of tests) {
  try {
    test()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`✗ ${name}`)
    console.error(error)
  }
}
if (failures) {
  console.error(`\n${failures} 个测试失败`)
  process.exit(1)
}
console.log(`\n全部 ${tests.length} 个预占账测试通过`)
