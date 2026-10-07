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
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useDeductQuotaMutation,
  useGetWorkspaceQuery,
  useValidatePackageMutation,
} from '@/app/api'
import type { LicenseRule } from '@/types/domain'
import { approvalLevelLabels, findApplicableRule } from '@/services/rules'

export function LicensePage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [validatePackage] = useValidatePackageMutation()
  const [deductQuota, deductState] = useDeductQuotaMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [amount, setAmount] = useState(5)

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const applicableRule = selected && data ? findApplicableRule(selected, data.rules) : undefined
  const currentRule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const packageFindings = data?.findings.filter((item) => item.packageId === selectedId) ?? []
  const hasHighFindings = packageFindings.some((item) => item.level === 'high')
  const remaining = selected ? selected.quotaLimit - selected.quotaUsed : 0

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
      title: '技术标签',
      dataIndex: 'technologyTags',
      width: 220,
      render: (values: string[]) => values.join('、') || '通用',
    },
    {
      title: '审批等级',
      dataIndex: 'approvalLevel',
      width: 110,
      render: (value: LicenseRule['approvalLevel']) => approvalLevelLabels[value],
    },
    {
      title: '规则额度',
      dataIndex: 'quotaLimit',
      width: 100,
    },
  ]

  async function refreshValidation() {
    if (!selected) return
    await validatePackage({ packageId: selected.id }).unwrap()
    message.success('规则匹配和缺失声明已重新校验')
  }

  async function deduct() {
    if (!selected) return
    try {
      await deductQuota({ packageId: selected.id, amount }).unwrap()
      message.success(`已扣减 ${amount} 个许可额度`)
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '额度扣减失败')
    }
  }

  return (
    <div>
      <PageHeader
        title="许可与额度"
        description="根据资料分类、国家地区、技术参数和人员范围匹配规则，补正声明并控制额度扣减。"
        actions={
          selected ? (
            <Button loading={deductState.isLoading} onClick={refreshValidation}>
              重新校验
            </Button>
          ) : null
        }
      />

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
              <Descriptions.Item label="人员范围">
                {selected.personnelScopes.join('、') || '无特别范围'}
              </Descriptions.Item>
              <Descriptions.Item label="审批状态">
                {selected.status === 'approved'
                  ? '已批准，可核对额度'
                  : selected.status === 'licensed'
                    ? '已扣减额度'
                    : '尚未完成审批'}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>规则匹配解释</h3>
            <Tag color={applicableRule ? 'success' : 'error'}>
              {applicableRule ? '存在适用规则' : '无适用规则'}
            </Tag>
          </div>
          {applicableRule ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message={applicableRule.name}
                description={applicableRule.explanation}
              />
              <div>
                <strong>必要声明核对</strong>
                <div style={{ marginTop: 8 }}>
                  {applicableRule.requiredDeclarations.map((declaration) => (
                    <Tag
                      key={declaration}
                      color={selected?.declarations.includes(declaration) ? 'success' : 'error'}
                    >
                      {declaration}
                    </Tag>
                  ))}
                </div>
              </div>
              <div>
                <strong>审批升级</strong>
                <div className="muted" style={{ marginTop: 5 }}>
                  规则要求 {approvalLevelLabels[applicableRule.approvalLevel]}；当前路线规则：
                  {currentRule?.name ?? '未生成'}。
                </div>
              </div>
            </Space>
          ) : (
            <Alert type="error" showIcon message="没有匹配到规则，必须执行人工判定。" />
          )}
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>缺失声明与升级要求</h3>
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
            <h3>许可额度扣减</h3>
            <SafetyCertificateOutlined />
          </div>
          {selected ? (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Progress
                percent={Math.round((selected.quotaUsed / selected.quotaLimit) * 100)}
                status={selected.quotaUsed >= selected.quotaLimit ? 'exception' : 'active'}
              />
              <div>
                已使用 {selected.quotaUsed}，剩余 {remaining}，规则上限 {selected.quotaLimit}
              </div>
              <InputNumber
                min={1}
                max={Math.max(1, remaining)}
                value={amount}
                onChange={(value) => setAmount(value ?? 1)}
                addonAfter="额度单位"
                style={{ width: '100%' }}
              />
              <Button
                type="primary"
                block
                disabled={
                  selected.status !== 'approved' ||
                  hasHighFindings ||
                  amount > remaining ||
                  remaining <= 0
                }
                loading={deductState.isLoading}
                onClick={deduct}
              >
                确认扣减并完成许可
              </Button>
              {selected.status !== 'approved' ? (
                <Alert type="warning" showIcon message="只有全部审批步骤完成后才允许扣减额度。" />
              ) : null}
              {hasHighFindings ? (
                <Alert type="error" showIcon message="存在高风险核对项，系统拒绝扣减额度。" />
              ) : null}
            </Space>
          ) : null}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>规则清单</h3>
          <span className="muted">规则用于解释匹配结果，不允许在审批页面直接修改</span>
        </div>
        <Table rowKey="id" columns={ruleColumns} dataSource={data.rules} pagination={false} />
      </section>
    </div>
  )
}
