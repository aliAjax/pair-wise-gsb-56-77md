import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Input,
  Modal,
  Space,
  Steps,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import {
  useAbandonConflictMutation,
  useDecideApprovalMutation,
  useGetWorkspaceQuery,
  useRecoverReservationsMutation,
  useResubmitConflictMutation,
  useSubmitApprovalMutation,
} from '@/app/api'
import type { ApprovalStep, MaterialPackage } from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'
import { poolUsage, reservationStatusLabels } from '@/services/quota'

export function ApprovalPage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [submitApproval, submitState] = useSubmitApprovalMutation()
  const [decideApproval, decideState] = useDecideApprovalMutation()
  const [recoverReservations, recoverState] = useRecoverReservationsMutation()
  const [resubmitConflict, resubmitState] = useResubmitConflictMutation()
  const [abandonConflict, abandonState] = useAbandonConflictMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [decision, setDecision] = useState<'approve' | 'return'>('approve')
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [decidingStep, setDecidingStep] = useState<ApprovalStep>()
  const [submitOpen, setSubmitOpen] = useState(false)
  const [submitComment, setSubmitComment] = useState('')
  const [simulateCrash, setSimulateCrash] = useState(false)

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const rule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const activeStep = selected?.approvalRoute.find((step) => step.status === 'active')
  const activeReservation = data?.reservations.find(
    (item) => item.id === selected?.activeReservationId && item.status === 'held',
  )
  const failedReservations = data?.reservations.filter((item) => item.status === 'failed') ?? []

  if (isLoading || !data) return <div className="panel">正在加载审批路线...</div>
  const workspace = data

  const pool = rule
    ? (() => {
        const { settled, held } = poolUsage(workspace.reservations, rule.id)
        return {
          settled,
          held,
          available: rule.quotaLimit - settled - held,
          limit: rule.quotaLimit,
        }
      })()
    : undefined

  const packageColumns: TableColumnsType<MaterialPackage> = [
    { title: '编号', dataIndex: 'code', width: 135 },
    { title: '资料包', dataIndex: 'title', minWidth: 220 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: MaterialPackage['status']) => <StatusTag status={value} />,
    },
    {
      title: '预占',
      width: 110,
      render: (_, record) => {
        const reservation = workspace.reservations.find(
          (item) => item.id === record.activeReservationId,
        )
        if (!reservation) return <span className="muted">无在途预占</span>
        const color =
          reservation.status === 'held'
            ? 'processing'
            : reservation.status === 'failed'
              ? 'warning'
              : 'default'
        return (
          <Tag color={color}>
            {reservationStatusLabels[reservation.status]} {reservation.amount}
          </Tag>
        )
      },
    },
    {
      title: '轮次',
      dataIndex: 'currentRound',
      width: 85,
      render: (value: number) => (value ? `第 ${value} 轮` : '未提交'),
    },
    {
      title: '当前步骤',
      width: 160,
      render: (_, record) =>
        record.approvalRoute.find((step) => step.status === 'active')?.role ?? '无活动步骤',
    },
  ]

  const stepColumns: TableColumnsType<ApprovalStep> = [
    { title: '顺序', dataIndex: 'order', width: 60 },
    { title: '审批角色', dataIndex: 'role', width: 150 },
    { title: '处理人', dataIndex: 'assignee', width: 120 },
    {
      title: '等级',
      dataIndex: 'level',
      width: 100,
      render: (value: ApprovalStep['level']) => approvalLevelLabels[value],
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: ApprovalStep['status']) => (
        <Tag
          color={
            value === 'approved'
              ? 'success'
              : value === 'active'
                ? 'processing'
                : value === 'returned'
                  ? 'error'
                  : 'default'
          }
        >
          {value === 'approved'
            ? '已通过'
            : value === 'active'
              ? '待审批'
              : value === 'returned'
                ? '已退回'
                : '未开始'}
        </Tag>
      ),
    },
    {
      title: '意见',
      dataIndex: 'comment',
      render: (value: string) => value || <span className="muted">无</span>,
    },
    {
      title: '预占依据',
      width: 150,
      render: (_, record) =>
        record.basisReservationId ? (
          <Tag title={record.basisReservationId}>批次 {record.basisReservationId.slice(-6)}</Tag>
        ) : (
          <span className="muted">沿用当前批次</span>
        ),
    },
    {
      title: '操作',
      width: 150,
      render: (_, record) =>
        record.status === 'active' ? (
          <Space>
            <Button
              type="link"
              onClick={() => {
                setDecidingStep(record)
                setDecision('approve')
                setDecisionOpen(true)
              }}
            >
              通过
            </Button>
            <Button
              type="link"
              danger
              onClick={() => {
                setDecidingStep(record)
                setDecision('return')
                setDecisionOpen(true)
              }}
            >
              退回
            </Button>
          </Space>
        ) : null,
    },
  ]

  async function confirmSubmit() {
    if (!selected) return
    try {
      await submitApproval({
        packageId: selected.id,
        comment: submitComment || undefined,
        simulateCrash,
      }).unwrap()
      if (simulateCrash) {
        message.warning('已模拟写入异常退出：预占批次完整保留，可点击“恢复未完成预占”继续。')
      } else {
        message.success('审批路线已生成并按规则上限预占额度')
      }
      setSubmitOpen(false)
      setSubmitComment('')
      setSimulateCrash(false)
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '提交被拒绝')
      setSubmitOpen(false)
      setSubmitComment('')
      setSimulateCrash(false)
    }
  }

  async function confirmDecision() {
    if (!selected || !decidingStep) return
    await decideApproval({
      packageId: selected.id,
      stepId: decidingStep.id,
      decision,
      comment,
    }).unwrap()
    message.success(
      decision === 'approve'
        ? '审批步骤已通过'
        : '资料包已退回，未完成预占已释放，进入新一轮补正',
    )
    setDecisionOpen(false)
    setComment('')
    setDecidingStep(undefined)
  }

  async function recover() {
    await recoverReservations().unwrap()
    message.success('未完成预占已恢复，重试未产生重复扣减')
  }

  async function resubmit(reservationId: string) {
    try {
      await resubmitConflict({ reservationId, comment: submitComment || undefined }).unwrap()
      message.success('冲突批次已在额度腾出后生效')
      setSubmitComment('')
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '重提失败')
    }
  }

  async function abandon(reservationId: string) {
    await abandonConflict({ reservationId }).unwrap()
    message.success('冲突批次已放弃，未占用任何额度')
  }

  const conflictReservation = selected?.pendingConflict
    ? workspace.reservations.find((item) => item.id === selected.pendingConflict?.reservationId)
    : undefined
  const submitDisabled = Boolean(activeStep) || selected?.status === 'licensed'

  return (
    <div>
      <PageHeader
        title="审批路线"
        description="进入升级审批即按规则上限预占额度；两人同时提交先到者生效，后到者保留意见与冲突。"
        actions={
          <Space>
            {failedReservations.length ? (
              <Button danger loading={recoverState.isLoading} onClick={recover}>
                恢复未完成预占 ({failedReservations.length})
              </Button>
            ) : null}
            {selected ? (
              <Button
                type="primary"
                disabled={submitDisabled}
                loading={submitState.isLoading}
                onClick={() => setSubmitOpen(true)}
              >
                提交或重新发起审批
              </Button>
            ) : null}
          </Space>
        }
      />

      {failedReservations.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`检测到 ${failedReservations.length} 个写入异常退出后保留的预占批次`}
          description="批次、依据和意见已完整落盘，恢复时只把原批次挂起，不会重复扣减额度。"
        />
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h3>待处理资料包</h3>
          <span className="muted">选择资料包后查看完整审批路线与预占账</span>
        </div>
        <Table
          rowKey="id"
          columns={packageColumns}
          dataSource={data.packages}
          pagination={false}
          rowClassName={(record) => (record.id === selectedId ? 'ant-table-row-selected' : '')}
          onRow={(record) => ({ onClick: () => setSelectedId(record.id) })}
        />
      </section>

      {selected ? (
        <>
          {selected.quotaBlocked ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              message="提交已被额度挡住"
              description={selected.quotaBlocked.reason}
            />
          ) : null}
          {selected.pendingConflict && conflictReservation ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              message="并发提交冲突：本资料包为后到者"
              description={
                <Space direction="vertical" size={8}>
                  <div>{selected.pendingConflict.reason}</div>
                  {conflictReservation.pendingComment ? (
                    <div>保留意见：{conflictReservation.pendingComment}</div>
                  ) : null}
                  <Space>
                    <Input
                      size="small"
                      style={{ width: 260 }}
                      placeholder="补充意见后随批次重提"
                      value={submitComment}
                      onChange={(event) => setSubmitComment(event.target.value)}
                    />
                    <Button
                      type="primary"
                      size="small"
                      loading={resubmitState.isLoading}
                      onClick={() => resubmit(conflictReservation.id)}
                    >
                      额度释放后重提
                    </Button>
                    <Button
                      size="small"
                      danger
                      loading={abandonState.isLoading}
                      onClick={() => abandon(conflictReservation.id)}
                    >
                      放弃该批次
                    </Button>
                  </Space>
                </Space>
              }
            />
          ) : null}

          <div className="two-column">
            <section className="panel">
              <div className="panel-title">
                <h3>{selected.title}</h3>
                <StatusTag status={selected.status} />
              </div>
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                {selected.approvalRoute.length ? (
                  <Steps
                    direction="vertical"
                    current={selected.approvalRoute.findIndex((step) => step.status === 'active')}
                    items={selected.approvalRoute.map((step) => ({
                      title: step.role,
                      description: `${step.assignee} · ${
                        step.status === 'approved'
                          ? '已通过（保留原依据）'
                          : step.status === 'returned'
                            ? '已退回'
                            : step.status === 'active'
                              ? '待处理'
                              : '等待前序步骤'
                      }`,
                      status:
                        step.status === 'approved'
                          ? 'finish'
                          : step.status === 'returned'
                            ? 'error'
                            : step.status === 'active'
                              ? 'process'
                              : 'wait',
                    }))}
                  />
                ) : (
                  <Alert type="info" showIcon message="尚未生成审批路线。" />
                )}
                <Button
                  onClick={() => setSubmitOpen(true)}
                  disabled={submitDisabled}
                  loading={submitState.isLoading}
                >
                  重新生成审批路线
                </Button>
              </Space>
            </section>

            <section className="panel">
              <div className="panel-title">
                <h3>预占账与规则轮次</h3>
                <Tag>{selected.currentRound ? `第 ${selected.currentRound} 轮` : '未提交'}</Tag>
              </div>
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="匹配规则">{rule?.name ?? '未匹配'}</Descriptions.Item>
                <Descriptions.Item label="规则等级">
                  {rule ? approvalLevelLabels[rule.approvalLevel] : '未知'}
                </Descriptions.Item>
                <Descriptions.Item label="额度池（同规则共享）">
                  {pool
                    ? `总额 ${pool.limit} · 实占 ${pool.settled} · 预占 ${pool.held} · 可预占 ${pool.available}`
                    : '未知'}
                </Descriptions.Item>
                <Descriptions.Item label="当前预占批次">
                  {activeReservation ? (
                    <Space direction="vertical" size={0}>
                      <Tag color="processing">
                        {reservationStatusLabels.held} {activeReservation.amount}
                      </Tag>
                      <span className="muted">批次 {activeReservation.id.slice(-8)}</span>
                    </Space>
                  ) : (
                    <span className="muted">无在途预占</span>
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="未关闭高风险">
                  {
                    data.findings.filter(
                      (item) => item.packageId === selected.id && item.level === 'high',
                    ).length
                  }
                </Descriptions.Item>
              </Descriptions>
            </section>
          </div>
        </>
      ) : null}

      {selected ? (
        <section className="panel">
          <div className="panel-title">
            <h3>步骤明细与历史意见</h3>
            <span className="muted">换版后已通过步骤保留原预占依据，未完成步骤按新版本重算预占。</span>
          </div>
          <Table
            rowKey="id"
            columns={stepColumns}
            dataSource={selected.approvalRoute}
            pagination={false}
          />
        </section>
      ) : null}

      <Modal
        title="提交审批并预占额度"
        open={submitOpen}
        onCancel={() => {
          setSubmitOpen(false)
          setSimulateCrash(false)
        }}
        onOk={confirmSubmit}
        confirmLoading={submitState.isLoading}
        okText="确认提交"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {pool ? (
            <Alert
              type={pool.available >= (rule?.quotaLimit ?? 0) ? 'success' : 'warning'}
              showIcon
              message={`规则额度池：总额 ${pool.limit}，实占 ${pool.settled}，在途预占 ${pool.held}，当前可预占 ${pool.available}`}
              description={`本次将按规则上限预占 ${rule?.quotaLimit ?? 0}；额度不足时直接挡住提交并说明缺额。`}
            />
          ) : null}
          <Input.TextArea
            rows={3}
            value={submitComment}
            onChange={(event) => setSubmitComment(event.target.value)}
            placeholder="提交意见（并发落败时该意见会保留在冲突批次中）"
          />
          <Checkbox checked={simulateCrash} onChange={(event) => setSimulateCrash(event.target.checked)}>
            模拟写入异常退出（预占批次保留，随后演示恢复）
          </Checkbox>
        </Space>
      </Modal>

      <Modal
        title={decision === 'approve' ? '通过当前审批步骤' : '退回并进入补正'}
        open={decisionOpen}
        onCancel={() => setDecisionOpen(false)}
        onOk={confirmDecision}
        confirmLoading={decideState.isLoading}
        okText={decision === 'approve' ? '确认通过' : '确认退回'}
        okButtonProps={{ danger: decision === 'return' }}
        cancelText="取消"
      >
        <Alert
          type={decision === 'approve' ? 'info' : 'warning'}
          showIcon
          message={
            decision === 'approve'
              ? '通过后进入下一审批角色；全部通过后预占自动转实占。'
              : '退回后当前预占立即释放，已通过步骤保留原依据，补充资料后可重新发起。'
          }
          style={{ marginBottom: 14 }}
        />
        <Input.TextArea
          rows={4}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={decision === 'approve' ? '填写审批意见' : '明确说明退回原因和补正要求'}
        />
      </Modal>
    </div>
  )
}
