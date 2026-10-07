import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Input,
  Modal,
  Popconfirm,
  Space,
  Steps,
  Table,
  Tag,
  Timeline,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { ExperimentOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import {
  useDecideApprovalMutation,
  useGetWorkspaceQuery,
  useReholdQuotaMutation,
  useSubmitApprovalMutation,
} from '@/app/api'
import type { ApprovalStep, MaterialPackage } from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'
import { activeHold, basisVersionLabel, ruleSummary } from '@/services/quota'

function errorText(error: unknown): string {
  if (typeof error === 'object' && error && 'data' in error) {
    return (error.data as { error?: string }).error ?? '操作失败'
  }
  return error instanceof Error ? error.message : '操作失败'
}

export function ApprovalPage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [submitApproval, submitState] = useSubmitApprovalMutation()
  const [reholdQuota, reholdState] = useReholdQuotaMutation()
  const [decideApproval, decideState] = useDecideApprovalMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [decision, setDecision] = useState<'approve' | 'return'>('approve')
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [decidingStep, setDecidingStep] = useState<ApprovalStep>()
  const [armCrashMode, setArmCrashMode] = useState<null | 'before-hold' | 'after-hold-save'>(null)

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const rule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const activeStep = selected?.approvalRoute.find((step) => step.status === 'active')
  const hold = selected && data ? activeHold(data, selected.id) : undefined
  const pool = rule && data ? ruleSummary(data, rule) : undefined
  const packageComments = useMemo(
    () =>
      data?.comments.filter(
        (item) => item.packageId === selectedId && item.kind !== undefined && item.kind !== 'manual',
      ) ?? [],
    [data, selectedId],
  )

  if (isLoading || !data) return <div className="panel">正在加载审批路线...</div>
  const workspace = data

  const packageColumns: TableColumnsType<MaterialPackage> = [
    { title: '编号', dataIndex: 'code', width: 135 },
    { title: '资料包', dataIndex: 'title', minWidth: 220 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: MaterialPackage['status']) => <StatusTag status={value} />,
    },
    {
      title: '轮次',
      dataIndex: 'currentRound',
      width: 85,
      render: (value: number) => (value ? `第 ${value} 轮` : '未提交'),
    },
    {
      title: '预占',
      width: 100,
      render: (_, record) => {
        const recordHold = activeHold(workspace, record.id)
        return recordHold ? <Tag color="gold">{recordHold.amount}</Tag> : <Tag>无</Tag>
      },
    },
    {
      title: '当前步骤',
      width: 150,
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
      title: '通过时依据（换版后保留）',
      width: 260,
      render: (_, record) =>
        record.status === 'approved' ? (
          <Space direction="vertical" size={0}>
            <span className="muted">{record.basisLabel ?? '历史步骤'}</span>
            <Tag color="geekblue">{record.basisVersionLabel ?? '旧版依据未留快照'}</Tag>
          </Space>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      title: '意见',
      dataIndex: 'comment',
      render: (value: string) => value || <span className="muted">无</span>,
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

  async function submitCurrent(crashPoint?: 'before-hold' | 'after-hold-save') {
    if (!selected) return
    const highFindings = workspace.findings.filter(
      (item) => item.packageId === selected.id && item.level === 'high',
    )
    if (highFindings.length) {
      message.error(`存在 ${highFindings.length} 项高风险核对项，请先修复后提交`)
      return
    }
    try {
      await submitApproval({ packageId: selected.id, crashPoint }).unwrap()
      message.success('审批路线已生成，并按规则上限完成额度预占')
      setArmCrashMode(null)
    } catch (error) {
      message.error(errorText(error), 8)
    }
  }

  async function recoverHold() {
    if (!selected) return
    try {
      await reholdQuota({ packageId: selected.id }).unwrap()
      message.success('已按当前版本与技术参数重新预占，可继续审批')
    } catch (error) {
      message.error(errorText(error), 8)
    }
  }

  async function confirmDecision() {
    if (!selected || !decidingStep) return
    try {
      await decideApproval({
        packageId: selected.id,
        stepId: decidingStep.id,
        decision,
        comment: commentText,
      }).unwrap()
      message.success(decision === 'approve' ? '审批步骤已通过（依据已留存）' : '资料包已退回，预占已释放回池')
      setDecisionOpen(false)
      setCommentText('')
      setDecidingStep(undefined)
    } catch (error) {
      message.error(errorText(error), 8)
    }
  }

  return (
    <div>
      <PageHeader
        title="审批路线与额度预占"
        description="提交审批（含升级审批）即按规则上限整池预占；文件现行版本、引用版本或技术参数变化后预占按新依据重算，已通过步骤保留原依据。"
        actions={
          selected ? (
            <Space>
              <Popconfirm
                title="模拟写入异常退出"
                description="先把完整批次落盘，再在预占前崩溃；刷新后自动恢复，不会重复扣减。"
                onConfirm={() => {
                  setArmCrashMode('before-hold')
                  submitCurrent('before-hold')
                }}
                okText="武装并提交"
                cancelText="取消"
              >
                <Button icon={<ExperimentOutlined />}>模拟提交崩溃</Button>
              </Popconfirm>
              <Button
                type="primary"
                disabled={Boolean(activeStep) || selected.status === 'quota-blocked'}
                loading={submitState.isLoading}
                onClick={() => submitCurrent()}
              >
                提交或重新发起审批
              </Button>
            </Space>
          ) : null
        }
      />

      <section className="panel">
        <div className="panel-title">
          <h3>待处理资料包</h3>
          <span className="muted">预占数字为该资料包当前持有的规则额度</span>
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
        <div className="two-column">
          <section className="panel">
            <div className="panel-title">
              <h3>{selected.title}</h3>
              <StatusTag status={selected.status} />
            </div>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {selected.status === 'quota-blocked' ? (
                <Alert
                  type="error"
                  showIcon
                  message="预占已失效：依据（文件版本/引用版本/技术参数）发生变化，按新依据重算时额度不足。"
                  description="已通过的审批步骤保留原依据；额度释放后点击“恢复预占”即可继续，未完成步骤不会被重复扣减。"
                  action={
                    <Button
                      type="primary"
                      ghost
                      size="small"
                      loading={reholdState.isLoading}
                      onClick={recoverHold}
                    >
                      恢复预占
                    </Button>
                  }
                />
              ) : null}
              {hold ? (
                <Alert
                  type="info"
                  showIcon
                  message={`当前预占 ${hold.amount}（第 ${hold.round} 轮），依据：${basisVersionLabel(selected.quotaBasis)}`}
                  description="审批完成前该规则池不可被其他窗口重复占用；退回会释放预占，全部通过则在许可页确认扣减。"
                />
              ) : (
                <Alert type="warning" showIcon message="当前没有有效预占，提交审批时将先预占额度。" />
              )}
              {selected.approvalRoute.length ? (
                <Steps
                  direction="vertical"
                  current={selected.approvalRoute.findIndex((step) => step.status === 'active')}
                  items={selected.approvalRoute.map((step) => ({
                    title: step.role,
                    description: `${step.assignee} · ${
                      step.status === 'approved'
                        ? '已通过'
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
                onClick={() => submitCurrent()}
                disabled={Boolean(activeStep) || selected.status === 'quota-blocked'}
                loading={submitState.isLoading}
              >
                重新生成审批路线
              </Button>
              {armCrashMode ? (
                <Alert
                  type="warning"
                  showIcon
                  message="已模拟写入异常退出：WAL 批次保留完整，刷新页面后会自动恢复未完成预占。"
                />
              ) : null}
            </Space>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>规则、额度与轮次</h3>
              <Tag>{selected.currentRound ? `第 ${selected.currentRound} 轮` : '未提交'}</Tag>
            </div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="匹配规则">{rule?.name ?? '未匹配'}</Descriptions.Item>
              <Descriptions.Item label="规则等级">
                {rule ? approvalLevelLabels[rule.approvalLevel] : '未知'}
              </Descriptions.Item>
              <Descriptions.Item label="规则池额度">
                {pool
                  ? `上限 ${pool.limit} / 已确认 ${pool.confirmed} / 预占 ${pool.held} / 可预占 ${pool.available}`
                  : '未知'}
              </Descriptions.Item>
              <Descriptions.Item label="收件方">{selected.recipient}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selected.endUse}</Descriptions.Item>
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
      ) : null}

      {selected && packageComments.length ? (
        <section className="panel">
          <div className="panel-title">
            <h3>预占冲突与依据变更留痕</h3>
          </div>
          <Timeline
            items={packageComments.map((item) => ({
              color: item.kind === 'conflict' ? 'red' : item.kind === 'recovery' ? 'purple' : 'orange',
              children: (
                <div>
                  <Space size={8} wrap>
                    <Tag color={item.kind === 'conflict' ? 'error' : item.kind === 'recovery' ? 'purple' : 'orange'}>
                      {item.kind === 'conflict' ? '冲突' : item.kind === 'recovery' ? '恢复' : '依据变更'}
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

      {selected ? (
        <section className="panel">
          <div className="panel-title">
            <h3>步骤明细与历史意见</h3>
            <span className="muted">已通过步骤展示通过时的依据版本，文件换版不覆盖</span>
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
              ? '通过后进入下一审批角色，本步骤依据版本将随审批记录留存。'
              : '退回后当前轮次结束并释放预占回池，补充资料后重新发起会按新依据重新预占。'
          }
          style={{ marginBottom: 14 }}
        />
        <Input.TextArea
          rows={4}
          value={commentText}
          onChange={(event) => setCommentText(event.target.value)}
          placeholder={decision === 'approve' ? '填写审批意见' : '明确说明退回原因和补正要求'}
        />
      </Modal>
    </div>
  )
}
