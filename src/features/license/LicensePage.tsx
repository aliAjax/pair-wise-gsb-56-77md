import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  InputNumber,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  ExperimentOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useConcurrentDemoMutation,
  useDeductQuotaMutation,
  useGetWorkspaceQuery,
  useRecoverBatchesMutation,
  useValidatePackageMutation,
} from '@/app/api'
import type {
  LicenseRule,
  QuotaConflict,
  QuotaReservation,
  ReviewComment,
} from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'
import { activeHold, ruleSummary } from '@/services/quota'

function errorText(error: unknown): string {
  if (typeof error === 'object' && error && 'data' in error) {
    return (error.data as { error?: string }).error ?? '操作失败'
  }
  return error instanceof Error ? error.message : '操作失败'
}

const reservationStatusMeta: Record<
  QuotaReservation['status'],
  { label: string; color: string }
> = {
  held: { label: '预占中', color: 'gold' },
  confirmed: { label: '已确认', color: 'green' },
  released: { label: '已释放', color: 'default' },
  voided: { label: '已作废', color: 'default' },
}

const commentKindMeta: Record<NonNullable<ReviewComment['kind']>, { label: string; color: string }> = {
  manual: { label: '意见', color: 'blue' },
  conflict: { label: '冲突', color: 'error' },
  basis: { label: '依据', color: 'orange' },
  recovery: { label: '恢复', color: 'purple' },
}

export function LicensePage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [validatePackage] = useValidatePackageMutation()
  const [deductQuota, deductState] = useDeductQuotaMutation()
  const [recoverBatches, recoverState] = useRecoverBatchesMutation()
  const [concurrentDemo, demoState] = useConcurrentDemoMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [amount, setAmount] = useState(5)
  const [crashNext, setCrashNext] = useState(false)

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const currentRule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const packageFindings = data?.findings.filter((item) => item.packageId === selectedId) ?? []
  const hasHighFindings = packageFindings.some((item) => item.level === 'high')
  const hold = selected && data ? activeHold(data, selected.id) : undefined
  const pool = currentRule && data ? ruleSummary(data, currentRule) : undefined

  useEffect(() => {
    if (hold) setAmount((value) => Math.min(value, Math.max(1, hold.amount)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold?.id])

  const pendingBatches = useMemo(
    () => data?.batches.filter((item) => item.status === 'pending') ?? [],
    [data],
  )

  if (isLoading || !data) return <div className="panel">正在加载许可规则...</div>

  const ruleColumns: TableColumnsType<LicenseRule> = [
    { title: '规则名称', dataIndex: 'name', minWidth: 240 },
    {
      title: '国家或地区',
      dataIndex: 'destinations',
      width: 135,
      render: (values: string[]) => values.join('、'),
    },
    {
      title: '审批等级',
      dataIndex: 'approvalLevel',
      width: 100,
      render: (value: LicenseRule['approvalLevel']) => approvalLevelLabels[value],
    },
    { title: '规则上限', dataIndex: 'quotaLimit', width: 90 },
    {
      title: '已确认（历史+实扣）',
      width: 140,
      render: (_, rule) => ruleSummary(data, rule).confirmed,
    },
    {
      title: '预占中',
      width: 90,
      render: (_, rule) => {
        const summary = ruleSummary(data, rule)
        return <Tag color={summary.held ? 'gold' : 'default'}>{summary.held}</Tag>
      },
    },
    {
      title: '可预占',
      width: 100,
      render: (_, rule) => {
        const summary = ruleSummary(data, rule)
        return (
          <Tag color={summary.available <= 0 ? 'error' : summary.available <= 10 ? 'warning' : 'success'}>
            {summary.available}
          </Tag>
        )
      },
    },
  ]

  const reservationColumns: TableColumnsType<QuotaReservation> = [
    {
      title: '资料包',
      width: 170,
      render: (_, record) =>
        data.packages.find((item) => item.id === record.packageId)?.code ?? record.packageId,
    },
    { title: '轮次', dataIndex: 'round', width: 70, render: (value: number) => `第 ${value} 轮` },
    { title: '额度', dataIndex: 'amount', width: 80 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: QuotaReservation['status']) => (
        <Tag color={reservationStatusMeta[value].color}>{reservationStatusMeta[value].label}</Tag>
      ),
    },
    {
      title: '依据',
      width: 200,
      render: (_, record) =>
        record.basis
          ? `第 ${record.basis.round} 轮 / ${record.basis.fileVersions.map((item) => item.versionLabel).join('、') || '无文件'}`
          : '基线（无快照）',
    },
    { title: '说明', dataIndex: 'reason', render: (value: string) => <span className="muted">{value}</span> },
  ]

  const conflictColumns: TableColumnsType<QuotaConflict> = [
    {
      title: '后到资料包',
      width: 170,
      render: (_, record) =>
        data.packages.find((item) => item.id === record.packageId)?.code ?? record.packageId,
    },
    {
      title: '先到资料包',
      width: 170,
      render: (_, record) =>
        data.packages.find((item) => item.id === record.competitorPackageId)?.code ??
        record.competitorPackageId,
    },
    { title: '需求', dataIndex: 'requested', width: 80 },
    { title: '当时可用', dataIndex: 'available', width: 100 },
    { title: '缺额', dataIndex: 'shortfall', width: 80, render: (value: number) => <Tag color="error">{value}</Tag> },
    { title: '原因', dataIndex: 'reason' },
  ]

  async function refreshValidation() {
    if (!selected) return
    await validatePackage({ packageId: selected.id }).unwrap()
    message.success('规则匹配和缺失声明已重新校验')
  }

  async function deduct() {
    if (!selected) return
    try {
      await deductQuota({
        packageId: selected.id,
        amount,
        crashPoint: crashNext ? 'after-batch-save' : undefined,
      }).unwrap()
      message.success(`已确认扣减 ${amount}，预占剩余已释放回池`)
      setCrashNext(false)
    } catch (error) {
      message.error(errorText(error))
    }
  }

  async function recover() {
    try {
      const result = await recoverBatches().unwrap()
      if (result.recovered.length) {
        result.recovered.forEach((note) => message.success(note, 6))
      } else {
        message.info('未完成批次仍缺额度，已保留完整批次，额度释放后可再次恢复。')
      }
    } catch (error) {
      message.error(errorText(error))
    }
  }

  async function runConcurrentDemo() {
    try {
      await concurrentDemo().unwrap()
      message.success('已模拟两人同时提交：先到者预占成功，后到者留下冲突意见', 5)
    } catch (error) {
      message.error(errorText(error))
    }
  }

  const maxDeduct = hold ? hold.amount : 0
  const packageComments = data.comments.filter((item) => item.packageId === selectedId)

  return (
    <div>
      <PageHeader
        title="许可与额度预占账"
        description="进入审批即按规则上限整池预占；现行版本、引用版本或技术参数变化后按新依据重算，已完成审批保留原依据，额度不重复占用。"
        actions={
          <Space>
            <Button
              icon={<ThunderboltOutlined />}
              loading={demoState.isLoading}
              onClick={runConcurrentDemo}
            >
              模拟两人同时提交
            </Button>
            {selected ? (
              <Button loading={recoverState.isLoading} onClick={refreshValidation}>
                重新校验
              </Button>
            ) : null}
          </Space>
        }
      />

      {pendingBatches.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`检测到 ${pendingBatches.length} 个异常退出后未完成的预占/扣减批次（WAL 已完整保留）`}
          description={
            <Space direction="vertical" style={{ width: '100%' }}>
              <span>
                恢复是幂等的：预占已存在则不重复建立，扣减已落账则不重复扣减；额度仍不足时批次继续保留，不重复占用。
              </span>
              <Button type="primary" ghost size="small" loading={recoverState.isLoading} onClick={recover}>
                立即恢复未完成批次
              </Button>
            </Space>
          }
        />
      ) : null}

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>选择资料包</h3>
            <Tag>{data.rules.length} 条规则</Tag>
          </div>
          <Select
            value={selectedId || undefined}
            style={{ width: '100%' }}
            onChange={setSelectedId}
            options={data.packages.map((item) => ({
              value: item.id,
              label: `${item.code} · ${item.title} · ${item.destination}`,
            }))}
          />
          {selected ? (
            <Descriptions column={1} bordered size="small" style={{ marginTop: 16 }}>
              <Descriptions.Item label="收件方">{selected.recipient}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selected.endUse}</Descriptions.Item>
              <Descriptions.Item label="技术参数">
                {selected.technologyTags.join('、')}
              </Descriptions.Item>
              <Descriptions.Item label="审批状态">
                {selected.status === 'approved'
                  ? '已批准，待确认扣减（预占仍持有）'
                  : selected.status === 'licensed'
                    ? '已确认扣减'
                    : selected.status === 'quota-blocked'
                      ? '依据变化后预占失效，待恢复'
                      : '审批在途（额度已预占）'}
              </Descriptions.Item>
              <Descriptions.Item label="当前预占依据">
                {selected.quotaBasis
                  ? `第 ${selected.quotaBasis.round} 轮 / ${selected.quotaBasis.fileVersions.map((item) => item.versionLabel).join('、') || '无文件'}`
                  : '无'}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>规则池台账</h3>
            {currentRule ? <Tag color="blue">{currentRule.name}</Tag> : null}
          </div>
          {pool && currentRule ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Progress
                percent={Math.min(
                  100,
                  Math.round(((pool.confirmed + pool.held) / pool.limit) * 100),
                )}
                status={pool.available <= 0 ? 'exception' : 'active'}
              />
              <div>
                规则上限 <strong>{pool.limit}</strong> · 已确认 {pool.confirmed} · 预占中{' '}
                <strong>{pool.held}</strong> · 可预占{' '}
                <Tag color={pool.available <= 0 ? 'error' : 'success'}>{pool.available}</Tag>
                {pool.overbooked ? <Tag color="warning">历史基线超占</Tag> : null}
              </div>
              <Alert
                type="info"
                showIcon
                message="两个审批窗口同时抢同一份额度：预占按规则上限整池占用，先到者生效，后到者被挡住并留冲突。"
              />
            </Space>
          ) : (
            <Alert type="warning" showIcon message="当前资料包尚未匹配规则。" />
          )}
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>缺失声明、依据失效与冲突</h3>
            <Tag color={hasHighFindings ? 'error' : 'success'}>{packageFindings.length} 项</Tag>
          </div>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {packageFindings.map((finding) => (
              <Alert
                key={finding.id}
                type={finding.level === 'high' ? 'error' : finding.level === 'medium' ? 'warning' : 'info'}
                showIcon
                message={finding.message}
                description={finding.action}
              />
            ))}
            {!packageFindings.length ? (
              <Alert type="success" showIcon message="当前资料包没有许可核对缺口。" />
            ) : null}
          </Space>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>预占转确认扣减</h3>
            <SafetyCertificateOutlined />
          </div>
          {selected ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message={
                  hold
                    ? `当前持有预占 ${hold.amount}（第 ${hold.round} 轮，依据 ${hold.basis?.fileVersions.map((item) => item.versionLabel).join('、') || '无文件'}）。`
                    : '当前没有有效预占。'
                }
              />
              <div>
                已确认 {selected.quotaUsed}，预占中 {hold?.amount ?? 0}，规则上限 {selected.quotaLimit}
              </div>
              <InputNumber
                min={1}
                max={Math.max(1, maxDeduct)}
                value={amount}
                onChange={(value) => setAmount(value ?? 1)}
                addonAfter="额度单位"
                style={{ width: '100%' }}
                disabled={!hold}
              />
              <Button
                type="primary"
                block
                disabled={
                  selected.status !== 'approved' ||
                  hasHighFindings ||
                  !hold ||
                  amount > maxDeduct
                }
                loading={deductState.isLoading}
                onClick={deduct}
              >
                确认扣减并完成许可（预占剩余释放回池）
              </Button>
              {selected.status !== 'approved' ? (
                <Alert type="warning" showIcon message="只有全部审批步骤完成后才允许确认扣减；审批期间额度已预占。" />
              ) : null}

              <Button
                block
                danger={crashNext}
                icon={<ExperimentOutlined />}
                onClick={() =>
                  setCrashNext((value) => {
                    message.info(!value ? '已武装：下一次确认扣减将在批次落盘后异常退出' : '已取消异常模拟')
                    return !value
                  })
                }
              >
                {crashNext ? '取消异常模拟' : '模拟写入异常退出（验证 WAL 恢复）'}
              </Button>
              {crashNext ? (
                <Alert type="error" showIcon message="已武装：下一次确认扣减将异常退出，请观察刷新后的自动恢复。" />
              ) : null}
            </Space>
          ) : null}
        </section>
      </div>

      {selected && packageComments.length ? (
        <section className="panel">
          <div className="panel-title">
            <h3>审批意见、冲突与依据变更留痕</h3>
          </div>
          <Timeline
            items={packageComments.slice(0, 12).map((item) => ({
              color:
                item.kind === 'conflict' ? 'red' : item.kind === 'basis' ? 'orange' : 'blue',
              children: (
                <div>
                  <Space size={8} wrap>
                    <Tag color={commentKindMeta[item.kind ?? 'manual'].color}>
                      {commentKindMeta[item.kind ?? 'manual'].label}
                    </Tag>
                    <strong>{item.author}</strong>
                    <span className="muted">
                      {new Date(item.createdAt).toLocaleString('zh-CN')} · 第 {item.round} 轮
                    </span>
                  </Space>
                  <div>{item.content}</div>
                </div>
              ),
            }))}
          />
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h3>规则额度池</h3>
          <span className="muted">已确认 = 历史基线 + 实扣；预占中 = 在途审批整池占用</span>
        </div>
        <Table rowKey="id" columns={ruleColumns} dataSource={data.rules} pagination={false} />
      </section>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>预占台账明细</h3>
            <Tag>{data.reservations.length} 笔</Tag>
          </div>
          <Table
            rowKey="id"
            columns={reservationColumns}
            dataSource={data.reservations}
            pagination={{ pageSize: 6, showSizeChanger: false }}
            size="small"
          />
        </section>
        <section className="panel">
          <div className="panel-title">
            <h3>并发冲突记录</h3>
            <Tag color={data.conflicts.length ? 'error' : 'success'}>{data.conflicts.length} 条</Tag>
          </div>
          {data.conflicts.length ? (
            <Table
              rowKey="id"
              columns={conflictColumns}
              dataSource={data.conflicts}
              pagination={{ pageSize: 6, showSizeChanger: false }}
              size="small"
            />
          ) : (
            <Alert type="info" showIcon message="暂无并发冲突。点击上方“模拟两人同时提交”可演示先到先得与缺额留痕。" />
          )}
        </section>
      </div>
    </div>
  )
}
