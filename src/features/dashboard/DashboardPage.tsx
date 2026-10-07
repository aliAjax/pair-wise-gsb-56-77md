import { Alert, Button, Progress, Space, Table, Tag } from 'antd'
import type { TableColumnsType } from 'antd'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import { useGetWorkspaceQuery } from '@/app/api'
import type { MaterialPackage, ValidationFinding } from '@/types/domain'
import { categoryLabels } from '@/services/mockData'

export function DashboardPage() {
  const navigate = useNavigate()
  const { data, isLoading } = useGetWorkspaceQuery()

  if (isLoading || !data) return <div className="panel">正在加载本地工作区...</div>

  const highFindings = data.findings.filter((item) => item.level === 'high')
  const activePackages = data.packages.filter((item) =>
    ['validating', 'reviewing', 'returned', 'quota-blocked'].includes(item.status),
  )
  const heldQuota = data.reservations
    .filter((item) => item.status === 'held')
    .reduce((sum, item) => sum + item.amount, 0)
  const pendingBatches = data.batches.filter((item) => item.status === 'pending').length
  const controlledPages = data.files.reduce(
    (total, file) =>
      total +
      (file.versions.find((version) => version.id === file.activeVersionId)?.pages.filter(
        (page) => page.controlled,
      ).length ?? 0),
    0,
  )
  const reviewedPages = data.files.reduce(
    (total, file) =>
      total +
      (file.versions.find((version) => version.id === file.activeVersionId)?.pages.filter(
        (page) => page.reviewedAt,
      ).length ?? 0),
    0,
  )
  const totalPages = data.files.reduce(
    (total, file) =>
      total +
      (file.versions.find((version) => version.id === file.activeVersionId)?.pages.length ?? 0),
    0,
  )

  const findingColumns: TableColumnsType<ValidationFinding> = [
    {
      title: '等级',
      dataIndex: 'level',
      width: 80,
      render: (level: ValidationFinding['level']) => (
        <Tag color={level === 'high' ? 'error' : level === 'medium' ? 'warning' : 'blue'}>
          {level === 'high' ? '高' : level === 'medium' ? '中' : '低'}
        </Tag>
      ),
    },
    {
      title: '核对结论',
      dataIndex: 'message',
      render: (_, record) => (
        <div>
          <div className="finding-message">{record.message}</div>
          <div className="finding-action">{record.action}</div>
        </div>
      ),
    },
    {
      title: '资料包',
      width: 160,
      render: (_, record) =>
        data.packages.find((item) => item.id === record.packageId)?.code ?? record.packageId,
    },
  ]

  const packageColumns: TableColumnsType<MaterialPackage> = [
    { title: '编号', dataIndex: 'code', width: 135 },
    { title: '资料包', dataIndex: 'title', width: 230 },
    {
      title: '类型',
      dataIndex: 'category',
      width: 100,
      render: (value: MaterialPackage['category']) => categoryLabels[value],
    },
    { title: '目的地', dataIndex: 'destination', width: 100 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: MaterialPackage['status']) => <StatusTag status={value} />,
    },
    {
      title: '审批轮次',
      dataIndex: 'currentRound',
      width: 100,
      render: (value: number) => (value ? `第 ${value} 轮` : '未提交'),
    },
  ]

  return (
    <div>
      <PageHeader
        title="运行总览"
        description="汇总待审批资料、规则缺口、逐页核对进度和许可额度使用情况。"
        actions={
          <>
            <Button onClick={() => navigate('/page-review')}>继续逐页核对</Button>
            <Button type="primary" onClick={() => navigate('/packages')}>
              查看资料包
            </Button>
          </>
        }
      />

      <section className="metric-grid">
        <div className="metric danger">
          <span>高风险核对项</span>
          <strong>{highFindings.length}</strong>
          <small>必须解决后才能批准或扣减额度</small>
        </div>
        <div className="metric info">
          <span>处理中资料包</span>
          <strong>{activePackages.length}</strong>
          <small>审批中、已退回或校验中</small>
        </div>
        <div className="metric warning">
          <span>受控技术页</span>
          <strong>{controlledPages}</strong>
          <small>当前版本已标记受控的页面</small>
        </div>
        <div className="metric info">
          <span>预占中额度</span>
          <strong>{heldQuota}</strong>
          <small>在途审批整池预占{pendingBatches ? ` · ${pendingBatches} 个批次待恢复` : ''}</small>
        </div>
        <div className="metric">
          <span>逐页核对进度</span>
          <strong>
            {reviewedPages} / {totalPages}
          </strong>
          <Progress
            percent={totalPages ? Math.round((reviewedPages / totalPages) * 100) : 0}
            showInfo={false}
            size="small"
          />
        </div>
      </section>

      {highFindings.length ? (
        <Alert
          showIcon
          type="error"
          message={`当前有 ${highFindings.length} 项高风险核对结论，系统不会在资料不完整时静默批准。`}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h2>高风险与待补正项</h2>
            <Button type="link" onClick={() => navigate('/licenses')}>
              查看规则解释
            </Button>
          </div>
          <Table
            rowKey="id"
            columns={findingColumns}
            dataSource={data.findings.slice(0, 7)}
            pagination={false}
            size="small"
          />
        </section>
        <section className="panel">
          <div className="panel-title">
            <h2>合规工作摘要</h2>
            <Tag>{data.rules.length} 条许可规则</Tag>
          </div>
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <div>
              <strong>版本治理</strong>
              <p className="muted">
                每个文件保留独立版本链，审批引用版本与现行版本不一致时直接阻断。
              </p>
            </div>
            <div>
              <strong>审批路线</strong>
              <p className="muted">
                目的地、资料分类、技术参数和人员范围共同决定标准、升级或高级审批。
              </p>
            </div>
            <div>
              <strong>额度预占</strong>
              <p className="muted">
                进入审批即按规则上限整池预占，两个审批窗口互斥；版本或技术参数变化后预占按新依据重算，审批完成后确认扣减。
              </p>
            </div>
          </Space>
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>处理中资料包</h2>
          <Button type="link" onClick={() => navigate('/approvals')}>
            进入审批
          </Button>
        </div>
        <Table
          rowKey="id"
          columns={packageColumns}
          dataSource={activePackages}
          pagination={false}
          onRow={(record) => ({
            onClick: () => navigate(`/packages/${record.id}`),
          })}
        />
      </section>
    </div>
  )
}
