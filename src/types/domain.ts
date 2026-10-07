export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'returned'
  | 'approved'
  | 'licensed'
  | 'locked'
  | 'quota-blocked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType =
  | 'missing-declaration'
  | 'escalation'
  | 'version-mismatch'
  | 'unclassified-page'
  | 'quota'
  | 'basis-changed'
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

export interface QuotaBasis {
  ruleId: string
  round: number
  packageLabel: string
  /** 各资料文件的「现行=引用」版本，作为审批依据 */
  fileVersions: { fileId: string; file: string; versionId: string; versionLabel: string }[]
  technologyTags: string[]
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
  /** 该步骤通过时的审批依据，文件换版后仍保留 */
  basisLabel?: string
  basisVersionLabel?: string
}

export interface QuotaReservation {
  id: string
  ruleId: string
  packageId: string
  round: number
  amount: number
  status: 'held' | 'confirmed' | 'released' | 'voided'
  reason: string
  /** 预占时的审批依据快照 */
  basis?: QuotaBasis
  createdAt: string
  updatedAt: string
  /** voided/released 时指向新的预占记录（按新版本重算） */
  replacedBy?: string
  sourceBatchId?: string
}

export interface QuotaBatch {
  id: string
  type: 'submit-hold' | 'rehold' | 'deduct-confirm'
  ruleId: string
  packageId: string
  round: number
  /** deduct-confirm 时最终确认扣减的额度 */
  amount?: number
  reservationId?: string
  basis?: QuotaBasis
  status: 'pending' | 'committed' | 'failed'
  note: string
  createdAt: string
  updatedAt: string
}

export interface QuotaConflict {
  id: string
  ruleId: string
  packageId: string
  competitorPackageId: string
  round: number
  requested: number
  available: number
  shortfall: number
  winnerPackageId?: string
  winnerBatchId?: string
  loserBatchId?: string
  reason: string
  createdAt: string
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
  kind?: 'manual' | 'conflict' | 'basis' | 'recovery'
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
  /** 当前生效预占的依据快照，文件换版/技术参数变化后重算 */
  quotaBasis?: QuotaBasis
  quotaUsed: number
  quotaLimit: number
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
  schemaVersion: number
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  reservations: QuotaReservation[]
  batches: QuotaBatch[]
  conflicts: QuotaConflict[]
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
