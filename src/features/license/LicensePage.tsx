import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useGetWorkspaceQuery,
  useRecoverReservationsMutation,
  useValidatePackageMutation,
} from '@/app/api'
import type { LicenseRule, QuotaPoolSnapshot, QuotaReservation } from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'
import { quotaPools, reservationStatusLabels } from '@/services/quota'

export function LicensePage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [validatePackage] = useValidatePackageMutation()
  const [recoverReservations, recoverState] = useRecoverReservationsMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const pools: QuotaPoolSnapshot[] = data ? quotaPools(data) : []
  const failedCount = data?.reservations.filter((item) => item.status === 'failed').length ?? 0
  const packageFindings = data?.findings.filter((item) => item.packageId === selectedId) ?? []
  const hasHighFindings = packageFindings.some((item) => item.level === 'high')

  if (isLoading || !data) return <div className="panel">正在加载许可规则...</div>

  const packageReservations = data.reservations.filter((item) => item.packageId === selectedId)

  const ruleColumns: TableColumnsType<LicenseRule> = [
    { title: '规则名称', dataIndex: 'name', minWidth: 240 },
    {
      title: '国家或地区',
      dataIndex: 'destinations',
      width: 135,
      render: (values: string[]) => values.join('、'),
    },
    {
      title: '技术标签',
      dataIndex: 'technologyTags',
      width: 200,
      render: (values: string[]) => values.join('、') || '通用',
    },
    {
      title: '审批等级',
      dataIndex: 'approvalLevel',
      width: 100,
      render: (value: LicenseRule['approvalLevel']) => approvalLevelLabels[value],
    },
    { title: '规则额度', dataIndex: 'quotaLimit', width: 90 },
  ]

  const poolColumns: TableColumnsType<QuotaPoolSnapshot> = [
    { title: '许可规则', dataIndex: 'ruleName', minWidth: 220 },
    { title: '总额', dataIndex: 'limit', width: 80 },
    {
      title: '实占（审批完成）',
      dataIndex: 'settled',
      width: 130,
      render: (value: number) => <Tag color="success">{value}</Tag>,
    },
    {
      title: '预占（审批在途）',
      dataIndex: 'held',
      width: 130,
      render: (value: number) => <Tag color="processing">{value}</Tag>,
    },
    {
      title: '占用进度',
      width: 200,
      render: (_, record) => (
        <Progress
          percent={Math.round((record.committed / record.limit) * 100)}
          status={record.available <= 0 ? 'exception' : 'active'}
          size="small"
        />
      ),
    },
    {
      title: '可预占',
      dataIndex: 'available',
      width: 90,
      render: (value: number) => (
        <Tag color={value <= 0 ? 'error' : value <= 10 ? 'warning' : 'default'}>
          {Math.max(0, value)}
        </Tag>
      ),
    },
  ]

  const reservationColumns: TableColumnsType<QuotaReservation> = [
    {
      title: '批次',
      dataIndex: 'id',
      width: 150,
      render: (value: string) => <span className="muted">{value.slice(-12)}</span>,
    },
    { title: '轮次', dataIndex: 'round', width: 70, render: (value: number) => `第 ${value} 轮` },
    { title: '金额', dataIndex: 'amount', width: 80 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: QuotaReservation['status'], record) => (
        <Tag
          color={
            value === 'held'
              ? 'processing'
              : value === 'settled'
                ? 'success'
                : value === 'conflicted'
                  ? 'error'
                  : value === 'failed'
                    ? 'warning'
                    : 'default'
          }
        >
          {reservationStatusLabels[value]}
          {record.baseline ? '（历史回填）' : ''}
        </Tag>
      ),
    },
    {
      title: '提交时间',
      dataIndex: 'submittedAt',
      width: 170,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    {
      title: '说明 / 冲突原因',
      render: (_, record) =>
        record.conflictReason ||
        (record.status === 'settled'
          ? '预占已在全部审批通过后转实占'
          : record.status === 'held'
            ? '审批在途，额度预占中'
            : '—'),
    },
  ]

  async function refreshValidation() {
    if (!selected) return
    await validatePackage({ packageId: selected.id }).unwrap()
    message.success('规则匹配、预占池占用和缺失声明已重新校验')
  }

  async function recover() {
    await recoverReservations().unwrap()
    message.success('未完成预占已恢复，未产生重复扣减')
  }

  return (
    <div>
      <PageHeader
        title="许可与预占账"
        description="额度按许可规则共享：进入审批按上限预占，全部审批通过后预占转实占；历史已用回填基线，不重复占用。"
        actions={
          <Space>
            {failedCount ? (
              <Button danger loading={recoverState.isLoading} onClick={recover}>
                恢复中断批次 ({failedCount})
              </Button>
            ) : null}
            <Button onClick={refreshValidation}>重新校验</Button>
          </Space>
        }
      />

      <section className="panel">
        <div className="panel-title">
          <h3>额度池占用（同一规则下所有审批窗口共享同一份额度）</h3>
          <SafetyCertificateOutlined />
        </div>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="预占账规则"
          description="提交（含升级）审批时按规则上限整额预占；两个窗口同时提交时先到者生效，后到者只留冲突与意见；审批退回释放预占，全部通过转实占；重试与恢复均不重复扣减。"
        />
        <Table rowKey="ruleId" columns={poolColumns} dataSource={pools} pagination={false} />
      </section>

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
              <Descriptions.Item label="历史已用（实占累计）">
                {selected.quotaUsed}
              </Descriptions.Item>
              <Descriptions.Item label="在途预占">
                {packageReservations
                  .filter((item) => item.status === 'held')
                  .reduce((sum, item) => sum + item.amount, 0)}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>缺失声明与阻断项</h3>
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
      </div>

      {selected ? (
        <section className="panel">
          <div className="panel-title">
            <h3>{selected.code} 的预占账明细</h3>
            <span className="muted">held 预占中 · settled 已实占 · conflicted 冲突未决 · failed 写入中断 · released 已释放</span>
          </div>
          <Table
            rowKey="id"
            columns={reservationColumns}
            dataSource={packageReservations}
            pagination={false}
          />
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h3>规则清单</h3>
          <span className="muted">规则上限即预占上限，规则不允许在审批页面直接修改</span>
        </div>
        <Table rowKey="id" columns={ruleColumns} dataSource={data.rules} pagination={false} />
      </section>
    </div>
  )
}
