import type {
  FileVersion,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  PageReview,
  WorkspaceState,
} from '@/types/domain'
import { createApprovalRoute, validatePackage } from './rules'

function pages(
  count: number,
  reviewed: boolean,
  overrides: Partial<PageReview> = {},
): PageReview[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `page-${crypto.randomUUID()}`,
    page: index + 1,
    category: 'technical',
    controlled: false,
    desensitized: false,
    note: '',
    reviewer: reviewed ? '王合规' : '',
    reviewedAt: reviewed ? '2026-09-27T04:00:00.000Z' : undefined,
    ...overrides,
  }))
}

function version(
  label: string,
  pageCount: number,
  reviewed: boolean,
  hash: string,
  summary: string,
  overrides: Partial<PageReview> = {},
): FileVersion {
  return {
    id: `version-${crypto.randomUUID()}`,
    label,
    uploadedAt: '2026-09-27T02:20:00.000Z',
    hash,
    sizeKb: 1280 + pageCount * 96,
    pages: pages(pageCount, reviewed, overrides),
    changeSummary: summary,
  }
}

const rules: LicenseRule[] = [
  {
    id: 'rule-sg-composite',
    name: '新加坡复合材料工艺资料许可规则',
    categories: ['drawing', 'technical'],
    destinations: ['新加坡'],
    technologyTags: ['复合材料', '工艺参数'],
    personnelScopes: [],
    requiredDeclarations: ['最终用户声明', '最终用途声明', '不扩散声明'],
    approvalLevel: 'enhanced',
    quotaLimit: 80,
    explanation: '涉及复合材料铺层、固化参数及模具资料，适用升级审批和额度扣减。',
  },
  {
    id: 'rule-de-software',
    name: '德国工业软件出口许可规则',
    categories: ['software'],
    destinations: ['德国'],
    technologyTags: ['工业控制', '加密算法'],
    personnelScopes: [],
    requiredDeclarations: ['最终用户声明', '软件用途声明'],
    approvalLevel: 'standard',
    quotaLimit: 120,
    explanation: '工业控制软件用于民用生产，不涉及特别人员范围时按标准审批。',
  },
  {
    id: 'rule-us-lithography',
    name: '美国半导体光刻技术高级审批规则',
    categories: ['drawing', 'technical', 'software'],
    destinations: ['美国'],
    technologyTags: ['半导体', '光刻', '精密运动控制'],
    personnelScopes: ['外籍人员', '第三方承包商'],
    requiredDeclarations: ['最终用户声明', '最终用途声明', '人员接触清单', '技术转移声明'],
    approvalLevel: 'senior',
    quotaLimit: 30,
    explanation: '技术参数和人员范围均触发高级审批，需核对第三方接触和最终用途。',
  },
  {
    id: 'rule-my-general',
    name: '马来西亚一般技术资料许可规则',
    categories: ['drawing', 'technical', 'software'],
    destinations: ['马来西亚'],
    technologyTags: [],
    personnelScopes: [],
    requiredDeclarations: ['最终用户声明', '最终用途声明'],
    approvalLevel: 'standard',
    quotaLimit: 100,
    explanation: '一般民用技术资料按标准路线审批，仍需逐页完成受控属性核对。',
  },
  {
    id: 'rule-global-default',
    name: '全球兜底出口管制规则',
    categories: ['drawing', 'technical', 'software'],
    destinations: ['*'],
    technologyTags: [],
    personnelScopes: [],
    requiredDeclarations: ['最终用户声明'],
    approvalLevel: 'enhanced',
    quotaLimit: 20,
    explanation: '未命中特定国家规则时使用兜底路线，并要求人工确认科技参数。',
  },
]

const v1 = version('V1.0', 8, true, 'A41C-90D2', '初始工艺规程')
const v2 = version('V1.1', 9, false, 'D9F2-114A', '新增铺层顺序与固化曲线', {
  controlled: true,
})
const sw1 = version('V2.0', 5, true, '7EA2-319F', '标准控制器软件包')
const sw2 = version('V2.1', 6, true, '52CC-8D10', '修复通信模块并更新校验文件')
const us1 = version('V3.2', 12, false, 'E11A-77B4', '光刻设备参数说明', { controlled: true })
const my1 = version('V1.0', 4, false, '88AB-3411', '厂房布置示意')

export function createInitialState(): WorkspaceState {
  const now = '2026-09-28T06:00:00.000Z'
  const packages: MaterialPackage[] = [
    {
      id: 'pkg-001',
      code: 'EC-2026-001',
      title: '复材机翼铺层工艺资料包',
      category: 'technical',
      applicant: '周明',
      recipient: 'Asia Aero Manufacturing Pte. Ltd.',
      destination: '新加坡',
      endUse: '民用航空结构件试制',
      technologyTags: ['复合材料', '工艺参数'],
      personnelScopes: ['第三方承包商'],
      declarations: ['最终用户声明', '最终用途声明'],
      status: 'reviewing',
      matchedRuleId: 'rule-sg-composite',
      approvalRoute: createApprovalRoute('enhanced'),
      currentRound: 1,
      quotaUsed: 36,
      quotaLimit: 80,
      createdAt: '2026-09-20T02:10:00.000Z',
      updatedAt: now,
      versions: [],
    },
    {
      id: 'pkg-002',
      code: 'EC-2026-002',
      title: '工业控制器基础软件包',
      category: 'software',
      applicant: '赵敏',
      recipient: 'Rhein Automation GmbH',
      destination: '德国',
      endUse: '民用生产线控制器维护',
      technologyTags: ['工业控制', '加密算法'],
      personnelScopes: [],
      declarations: ['最终用户声明', '软件用途声明'],
      status: 'approved',
      matchedRuleId: 'rule-de-software',
      approvalRoute: createApprovalRoute('standard').map((step) => ({
        ...step,
        status: 'approved',
        comment: '资料范围和声明完整。',
        decidedAt: '2026-09-27T03:20:00.000Z',
      })),
      currentRound: 1,
      quotaUsed: 42,
      quotaLimit: 120,
      createdAt: '2026-09-18T04:30:00.000Z',
      updatedAt: '2026-09-27T03:20:00.000Z',
      versions: [],
    },
    {
      id: 'pkg-003',
      code: 'EC-2026-003',
      title: '精密光刻运动控制技术说明',
      category: 'technical',
      applicant: '林越',
      recipient: 'Pacific Semiconductor Research Inc.',
      destination: '美国',
      endUse: '半导体工艺联合研究',
      technologyTags: ['半导体', '光刻', '精密运动控制'],
      personnelScopes: ['外籍人员', '第三方承包商'],
      declarations: ['最终用户声明', '最终用途声明', '技术转移声明'],
      status: 'returned',
      matchedRuleId: 'rule-us-lithography',
      approvalRoute: createApprovalRoute('senior').map((step, index) =>
        index === 0
          ? {
              ...step,
              status: 'returned' as const,
              comment: '缺少人员接触清单。',
              decidedAt: '2026-09-26T08:10:00.000Z',
            }
          : { ...step },
      ),
      currentRound: 2,
      quotaUsed: 27,
      quotaLimit: 30,
      createdAt: '2026-09-16T01:15:00.000Z',
      updatedAt: '2026-09-26T08:10:00.000Z',
      versions: [],
    },
    {
      id: 'pkg-004',
      code: 'EC-2026-004',
      title: '联合厂房电气布置图',
      category: 'drawing',
      applicant: '许航',
      recipient: 'Kuala Engineering Sdn. Bhd.',
      destination: '马来西亚',
      endUse: '厂房施工布置',
      technologyTags: ['通用电气'],
      personnelScopes: [],
      declarations: ['最终用户声明'],
      status: 'draft',
      matchedRuleId: 'rule-my-general',
      approvalRoute: [],
      currentRound: 0,
      quotaUsed: 8,
      quotaLimit: 100,
      createdAt: '2026-09-28T00:20:00.000Z',
      updatedAt: now,
      versions: [],
    },
  ]

  const files: MaterialFile[] = [
    {
      id: 'file-001-a',
      packageId: 'pkg-001',
      name: '铺层工艺规程.pdf',
      kind: 'technical',
      activeVersionId: v2.id,
      referencedVersionId: v1.id,
      versions: [v1, v2],
    },
    {
      id: 'file-001-b',
      packageId: 'pkg-001',
      name: '模具装配图.dwg',
      kind: 'drawing',
      activeVersionId: v1.id,
      referencedVersionId: v1.id,
      versions: [v1],
    },
    {
      id: 'file-002-a',
      packageId: 'pkg-002',
      name: 'controller-runtime.zip',
      kind: 'software',
      activeVersionId: sw2.id,
      referencedVersionId: sw2.id,
      versions: [sw1, sw2],
    },
    {
      id: 'file-003-a',
      packageId: 'pkg-003',
      name: '光刻平台运动控制说明.pdf',
      kind: 'technical',
      activeVersionId: us1.id,
      referencedVersionId: us1.id,
      versions: [us1],
    },
    {
      id: 'file-004-a',
      packageId: 'pkg-004',
      name: '厂房电气总平面图.dwg',
      kind: 'drawing',
      activeVersionId: my1.id,
      referencedVersionId: my1.id,
      versions: [my1],
    },
  ]

  packages.forEach((packageItem) => {
    const summary =
      packageItem.status === 'draft'
        ? '初始创建资料包。'
        : '完成申报资料汇总并进入审批。'
    packageItem.versions.push({
      id: `pkg-version-${crypto.randomUUID()}`,
      label: 'V1.0',
      createdAt: packageItem.createdAt,
      createdBy: packageItem.applicant,
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
          files
            .filter((file) => file.packageId === packageItem.id)
            .map((file) => [file.id, file.activeVersionId]),
        ),
      },
    })
    if (packageItem.id === 'pkg-001') {
      packageItem.versions.push({
        id: 'pkg-version-pkg-001-v1-1',
        label: 'V1.1',
        createdAt: '2026-09-27T05:30:00.000Z',
        createdBy: '周明',
        summary: '新增最终用途声明要求，并调整工艺参数资料范围。',
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: '民用航空结构件试制',
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: ['最终用户声明'],
          activeFileVersions: {
            'file-001-a': v1.id,
            'file-001-b': v1.id,
          },
        },
      })
    }
  })

  const findings = packages.flatMap((packageItem) =>
    validatePackage(packageItem, files, rules),
  )
  return {
    packages,
    files,
    rules,
    findings,
    comments: [
      {
        id: 'comment-1',
        packageId: 'pkg-001',
        author: '合规专员',
        content: '第 7 页固化温度属于受控技术参数，请校核脱敏后版本是否已替换。',
        createdAt: '2026-09-27T07:30:00.000Z',
        round: 1,
      },
      {
        id: 'comment-2',
        packageId: 'pkg-003',
        author: '技术安全负责人',
        content: '本轮退回原因：人员接触清单缺失，且外籍人员范围未在最终用户证明中说明。',
        createdAt: '2026-09-26T08:10:00.000Z',
        round: 2,
      },
    ],
    audit: [
      {
        id: 'audit-1',
        packageId: 'pkg-001',
        action: '拆解资料包',
        target: '复材机翼铺层工艺资料包',
        operator: '合规专员',
        detail: '拆分为 2 个文件，共 17 页。',
        createdAt: '2026-09-27T02:30:00.000Z',
      },
      {
        id: 'audit-2',
        packageId: 'pkg-003',
        action: '审批退回',
        target: '精密光刻运动控制技术说明',
        operator: '技术安全负责人',
        detail: '需要补充人员接触清单并重新核对最终用途。',
        createdAt: '2026-09-26T08:10:00.000Z',
      },
      {
        id: 'audit-3',
        packageId: 'pkg-002',
        action: '批准资料包',
        target: '工业控制器基础软件包',
        operator: '合规专员',
        detail: '全部审批步骤完成，等待许可额度扣减。',
        createdAt: '2026-09-27T03:20:00.000Z',
      },
    ],
  }
}

export const categoryLabels = {
  drawing: '图纸',
  technical: '技术说明',
  software: '软件包',
} as const

export const packageStatusLabels: Record<MaterialPackage['status'], string> = {
  draft: '草稿',
  validating: '校验中',
  reviewing: '审批中',
  returned: '已退回',
  approved: '已批准',
  licensed: '已许可',
  locked: '已归档',
}
