import type { WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'

const STORAGE_KEY = 'export-control-review-v1'

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  try {
    return JSON.parse(raw) as WorkspaceState
  } catch {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  saveWorkspace(initial)
  return initial
}
