import type { WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'
import { migrateWorkspace, recoverReservations } from './quota'

const STORAGE_KEY = 'export-control-review-v2'
const LEGACY_KEY = 'export-control-review-v1'

/**
 * 读取后统一升级：
 * 1. 旧版本数据（v1）按当前状态回填预占基线，历史已用不重新占用；
 * 2. 恢复写入异常退出时保留的 failed 批次，重试不重复扣减。
 */
export function loadWorkspace(): WorkspaceState {
  let state: WorkspaceState
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const legacyRaw = !raw ? window.localStorage.getItem(LEGACY_KEY) : null
  if (!raw && !legacyRaw) {
    state = createInitialState()
    saveWorkspace(state)
    return state
  }
  try {
    state = JSON.parse((raw ?? legacyRaw) as string) as WorkspaceState
  } catch {
    state = createInitialState()
    saveWorkspace(state)
    return state
  }

  migrateWorkspace(state, new Date().toISOString())
  const recoveryEvents = recoverReservations(state, new Date().toISOString())
  if (recoveryEvents.length || legacyRaw) {
    state.audit = [
      ...recoveryEvents.map((event) => ({
        ...event,
        id: `audit-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
      })),
      ...state.audit,
    ]
    if (legacyRaw) window.localStorage.removeItem(LEGACY_KEY)
    saveWorkspace(state)
  }
  return state
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  window.localStorage.removeItem(LEGACY_KEY)
  saveWorkspace(initial)
  return initial
}
