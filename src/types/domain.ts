export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'returned'
  | 'approved'
  | 'licensed'
  | 'locked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType =
  | 'missing-declaration'
  | 'escalation'
  | 'version-mismatch'
  | 'unclassified-page'
  | 'quota'
  | 'quota-conflict'

export interface PageReview {
  id: string
  page: number
  category: MaterialCategory
  controlled: boolean
  desensitized: boolean
  note: string
  reviewer: string
  reviewedAt?: string
}

export interface FileVersion {
  id: string
  label: string
  uploadedAt: string
  hash: string
  sizeKb: number
  pages: PageReview[]
  changeSummary: string
}

export interface MaterialFile {
  id: string
  packageId: string
  name: string
  kind: MaterialCategory
  activeVersionId: string
  referencedVersionId: string
  versions: FileVersion[]
}

export interface ApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: 'waiting' | 'active' | 'approved' | 'returned'
  comment: string
  decidedAt?: string
  /** 该步骤通过时所依据的预占账编号；已完成步骤保留原依据，不受后续版本变化影响。 */
  basisReservationId?: string
}

/**
 * 额度预占依据指纹：由资料包技术参数与文件引用版本构成。
 * 指纹变化即代表审批依据失效，需要按新版本重算预占。
 */
export interface QuotaBasis {
  ruleId: string
  technologyTags: string[]
  personnelScopes: string[]
  category: MaterialCategory
  destination: string
  declarations: string[]
  /** fileId -> 审批引用版本 id */
  fileReferences: Record<string, string>
  /** fileId -> 现行版本 id */
  fileActive: Record<string, string>
  /** fileId -> 引用版本的内容哈希，用于确认引用版本本身未被改写 */
  fileHashes: Record<string, string>
}

export type QuotaReservationStatus =
  | 'held' // 审批进行中，额度预占
  | 'settled' // 审批完成，预占转实占
  | 'released' // 退回或依据失效，预占释放
  | 'conflicted' // 并发提交冲突，提交未生效，仅保留意见
  | 'failed' // 写入异常中断，批次保留待恢复

export interface QuotaReservation {
  id: string
  packageId: string
  ruleId: string
  round: number
  amount: number
  status: QuotaReservationStatus
  basis: QuotaBasis
  /** 乐观锁/竞态令牌：先到者生效，后到者按冲突处理 */
  versionToken: string
  conflictWith?: string
  conflictReason?: string
  /** 后到者或异常退出时保留的审批意见，不占用额度 */
  pendingComment?: string
  /** 旧数据回填的历史批次，结算时不再累加 quotaUsed */
  baseline?: boolean
  submittedBy: string
  submittedAt: string
  settledAt?: string
  releasedAt?: string
}

export interface PackageVersion {
  id: string
  label: string
  createdAt: string
  createdBy: string
  summary: string
  snapshot: {
    title: string
    category: MaterialCategory
    destination: string
    endUse: string
    technologyTags: string[]
    personnelScopes: string[]
    declarations: string[]
    activeFileVersions: Record<string, string>
  }
}

export interface ReviewComment {
  id: string
  packageId: string
  author: string
  content: string
  createdAt: string
  round: number
}

export interface MaterialPackage {
  id: string
  code: string
  title: string
  category: MaterialCategory
  applicant: string
  recipient: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  declarations: string[]
  status: PackageStatus
  matchedRuleId?: string
  approvalRoute: ApprovalStep[]
  currentRound: number
  /** 历史已用额度（实占），仅在预占转实占时增加；旧数据回填基线后不再变动。 */
  quotaUsed: number
  /** 规则额度上限（许可总额）。 */
  quotaLimit: number
  /** 当前生效预占账（held/conflicted/failed 批次恢复中使用）；结算后清空。 */
  activeReservationId?: string
  /** 并发提交落败时保留的意见与冲突说明，供审批页展示。 */
  pendingConflict?: { reservationId: string; reason: string; comment: string; at: string }
  /** 额度不足或依据失效被挡住提交时的阻断信息（含缺额）。 */
  quotaBlocked?: { reason: string; shortage: number; at: string }
  createdAt: string
  updatedAt: string
  versions: PackageVersion[]
}

export interface LicenseRule {
  id: string
  name: string
  categories: MaterialCategory[]
  destinations: string[]
  technologyTags: string[]
  personnelScopes: string[]
  requiredDeclarations: string[]
  approvalLevel: ApprovalLevel
  quotaLimit: number
  explanation: string
}

export interface ValidationFinding {
  id: string
  packageId: string
  type: FindingType
  level: FindingLevel
  message: string
  action: string
  ruleId?: string
}

export interface AuditEntry {
  id: string
  packageId?: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

export interface WorkspaceState {
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  /** 额度预占账（按许可规则共享同一额度池）。 */
  reservations: QuotaReservation[]
}

export interface QuotaPoolSnapshot {
  ruleId: string
  ruleName: string
  limit: number
  /** 已完成审批的实占总额 */
  settled: number
  /** 审批进行中的预占总额 */
  held: number
  /** 实占 + 预占 */
  committed: number
  /** 当前尚可预占的额度 */
  available: number
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
