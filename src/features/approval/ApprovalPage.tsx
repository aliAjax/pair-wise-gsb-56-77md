import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
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
  useDecideApprovalMutation,
  useGetWorkspaceQuery,
  useSubmitApprovalMutation,
} from '@/app/api'
import type { ApprovalStep, MaterialPackage } from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'

export function ApprovalPage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [submitApproval, submitState] = useSubmitApprovalMutation()
  const [decideApproval, decideState] = useDecideApprovalMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [decision, setDecision] = useState<'approve' | 'return'>('approve')
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [decidingStep, setDecidingStep] = useState<ApprovalStep>()

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const rule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const activeStep = selected?.approvalRoute.find((step) => step.status === 'active')

  if (isLoading || !data) return <div className="panel">正在加载审批路线...</div>
  const workspace = data

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

  async function submitCurrent() {
    if (!selected) return
    const highFindings = workspace.findings.filter(
      (item) => item.packageId === selected.id && item.level === 'high',
    )
    if (highFindings.length) {
      message.error('存在高风险核对项，请先修复后提交')
      return
    }
    await submitApproval({ packageId: selected.id }).unwrap()
    message.success('审批路线已生成或重新发起')
  }

  async function confirmDecision() {
    if (!selected || !decidingStep) return
    await decideApproval({
      packageId: selected.id,
      stepId: decidingStep.id,
      decision,
      comment,
    }).unwrap()
    message.success(decision === 'approve' ? '审批步骤已通过' : '资料包已退回，进入新一轮补正')
    setDecisionOpen(false)
    setComment('')
    setDecidingStep(undefined)
  }

  return (
    <div>
      <PageHeader
        title="审批路线"
        description="按规则等级生成顺序审批步骤，保留逐项意见并支持多轮退回、重新发起。"
        actions={
          selected ? (
            <Button
              type="primary"
              disabled={Boolean(activeStep)}
              loading={submitState.isLoading}
              onClick={submitCurrent}
            >
              提交或重新发起审批
            </Button>
          ) : null
        }
      />

      <section className="panel">
        <div className="panel-title">
          <h3>待处理资料包</h3>
          <span className="muted">选择资料包后查看完整审批路线</span>
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
              <Button onClick={submitCurrent} disabled={Boolean(activeStep)} loading={submitState.isLoading}>
                重新生成审批路线
              </Button>
            </Space>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>规则与轮次</h3>
              <Tag>{selected.currentRound ? `第 ${selected.currentRound} 轮` : '未提交'}</Tag>
            </div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="匹配规则">{rule?.name ?? '未匹配'}</Descriptions.Item>
              <Descriptions.Item label="规则等级">
                {rule ? approvalLevelLabels[rule.approvalLevel] : '未知'}
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

      {selected ? (
        <section className="panel">
          <div className="panel-title">
            <h3>步骤明细与历史意见</h3>
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
              ? '通过后进入下一审批角色。'
              : '退回后当前轮次结束，补充资料后可重新发起并增加轮次。'
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
