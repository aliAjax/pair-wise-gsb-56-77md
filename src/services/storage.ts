import type { WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'
import { backfillBaselineReservations } from './quota'

const STORAGE_KEY = 'export-control-review-v1'
export const SCHEMA_VERSION = 2

type LegacyWorkspace = Omit<WorkspaceState, 'schemaVersion' | 'reservations' | 'batches' | 'conflicts'>

function migrate(raw: LegacyWorkspace): WorkspaceState {
  const state: WorkspaceState = {
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    reservations: [],
    batches: [],
    conflicts: [],
  }
  // 旧数据升级：按当前状态回填基线，历史已用额度不重新占用
  backfillBaselineReservations(state, { baseline: true })
  state.audit.unshift({
    id: `audit-${crypto.randomUUID()}`,
    action: '数据升级',
    target: '预占台账 V2',
    operator: '系统',
    detail:
      '旧数据升级为预占账：历史已用额度回填为确认基线（不重新占用），审批中资料包按规则上限回填预占基线。',
    createdAt: new Date().toISOString(),
  })
  return state
}

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  let parsed: WorkspaceState
  try {
    parsed = JSON.parse(raw) as WorkspaceState
  } catch {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  if (!parsed.schemaVersion || parsed.schemaVersion < SCHEMA_VERSION) {
    const migrated = migrate(parsed as unknown as LegacyWorkspace)
    saveWorkspace(migrated)
    return migrated
  }
  return parsed
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION }),
  )
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  saveWorkspace(initial)
  return initial
}
