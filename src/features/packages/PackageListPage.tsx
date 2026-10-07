import { useState } from 'react'
import { Button, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd'
import type { TableColumnsType } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import {
  setMaterialCategory,
  setPackageSearch,
  setPackageStatus,
} from '@/app/uiSlice'
import { useCreatePackageMutation, useGetWorkspaceQuery } from '@/app/api'
import type { MaterialCategory, MaterialPackage } from '@/types/domain'
import { categoryLabels } from '@/services/mockData'
import { findApplicableRule } from '@/services/rules'

interface CreatePackageValues {
  title: string
  category: MaterialCategory
  applicant: string
  recipient: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  declarations: string[]
}

export function PackageListPage() {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const [form] = Form.useForm<CreatePackageValues>()
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useGetWorkspaceQuery()
  const [createPackage, createState] = useCreatePackageMutation()
  const filters = useAppSelector((state) => state.ui)

  if (isLoading || !data) return <div className="panel">正在加载资料包...</div>

  const filtered = data.packages.filter((item) => {
    const text = `${item.code}${item.title}${item.recipient}${item.applicant}`.toLowerCase()
    return (
      (!filters.packageSearch || text.includes(filters.packageSearch.toLowerCase())) &&
      (!filters.packageStatus || item.status === filters.packageStatus) &&
      (!filters.materialCategory || item.category === filters.materialCategory)
    )
  })

  const columns: TableColumnsType<MaterialPackage> = [
    { title: '资料包编号', dataIndex: 'code', width: 140 },
    {
      title: '名称与收件方',
      dataIndex: 'title',
      minWidth: 260,
      render: (_, record) => (
        <div>
          <strong>{record.title}</strong>
          <div className="muted" style={{ marginTop: 4 }}>
            {record.recipient}
          </div>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'category',
      width: 100,
      render: (value: MaterialCategory) => categoryLabels[value],
    },
    { title: '目的地', dataIndex: 'destination', width: 105 },
    {
      title: '技术标签',
      dataIndex: 'technologyTags',
      width: 220,
      render: (tags: string[]) => (
        <Space size={[4, 4]} wrap>
          {tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '匹配规则',
      dataIndex: 'matchedRuleId',
      width: 210,
      render: (ruleId: string | undefined) =>
        data.rules.find((rule) => rule.id === ruleId)?.name ?? '待校验',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: MaterialPackage['status']) => <StatusTag status={value} />,
    },
    {
      title: '操作',
      width: 110,
      fixed: 'right',
      render: (_, record) => (
        <Button type="link" onClick={() => navigate(`/packages/${record.id}`)}>
          打开工作区
        </Button>
      ),
    },
  ]

  async function submitCreate() {
    const values = await form.validateFields()
    const now = new Date().toISOString()
    const draft: Omit<
      MaterialPackage,
      'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
    > = {
      ...values,
      code: `EC-2026-${String(data!.packages.length + 1).padStart(3, '0')}`,
      status: 'draft',
      quotaUsed: 0,
      quotaLimit:
        findApplicableRule(
          {
            ...values,
            id: 'temp',
            code: 'temp',
            status: 'draft',
            approvalRoute: [],
            currentRound: 0,
            quotaUsed: 0,
            quotaLimit: 0,
            createdAt: now,
            updatedAt: now,
            versions: [],
          },
          data!.rules,
        )?.quotaLimit ?? 20,
    }
    const result = await createPackage({ package: draft }).unwrap()
    const created = result.packages.find((item) => item.code === draft.code)
    message.success('资料包已创建')
    setOpen(false)
    form.resetFields()
    if (created) navigate(`/packages/${created.id}`)
  }

  return (
    <div>
      <PageHeader
        title="资料包工作区"
        description="按图纸、技术说明和软件包组织申报资料，维护收件方、最终用途与声明。"
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            新建资料包
          </Button>
        }
      />

      <div className="toolbar">
        <Input.Search
          allowClear
          placeholder="搜索编号、名称、收件方或申请人"
          value={filters.packageSearch}
          onChange={(event) => dispatch(setPackageSearch(event.target.value))}
          style={{ width: 310 }}
        />
        <Select
          allowClear
          placeholder="资料类型"
          value={filters.materialCategory || undefined}
          onChange={(value) => dispatch(setMaterialCategory(value ?? ''))}
          options={Object.entries(categoryLabels).map(([value, label]) => ({ value, label }))}
          style={{ width: 140 }}
        />
        <Select
          allowClear
          placeholder="审批状态"
          value={filters.packageStatus || undefined}
          onChange={(value) => dispatch(setPackageStatus(value ?? ''))}
          options={[
            { value: 'draft', label: '草稿' },
            { value: 'validating', label: '校验中' },
            { value: 'reviewing', label: '审批中' },
            { value: 'returned', label: '已退回' },
            { value: 'approved', label: '已批准' },
            { value: 'licensed', label: '已许可' },
            { value: 'locked', label: '已归档' },
          ]}
          style={{ width: 140 }}
        />
        <span className="grow" />
        <span className="muted">共 {filtered.length} 个资料包</span>
      </div>

      <section className="panel">
        <Table
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={filtered}
          scroll={{ x: 1320 }}
          pagination={{ pageSize: 8, showSizeChanger: false }}
        />
      </section>

      <Modal
        title="新建出口技术资料包"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submitCreate}
        confirmLoading={createState.isLoading}
        okText="创建并打开"
        cancelText="取消"
        width={680}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            category: 'technical',
            applicant: '当前用户',
            destination: '马来西亚',
            technologyTags: ['通用电气'],
            personnelScopes: [],
            declarations: ['最终用户声明'],
          }}
        >
          <Form.Item name="title" label="资料包名称" rules={[{ required: true }]}>
            <Input placeholder="输入可识别的资料包名称" />
          </Form.Item>
          <div className="two-column">
            <Form.Item name="category" label="资料类型" rules={[{ required: true }]}>
              <Select
                options={Object.entries(categoryLabels).map(([value, label]) => ({ value, label }))}
              />
            </Form.Item>
            <Form.Item name="applicant" label="申请人" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </div>
          <Form.Item name="recipient" label="境外收件方" rules={[{ required: true }]}>
            <Input placeholder="填写单位全称" />
          </Form.Item>
          <div className="two-column">
            <Form.Item name="destination" label="国家或地区" rules={[{ required: true }]}>
              <Select
                options={['新加坡', '德国', '美国', '马来西亚', '日本'].map((value) => ({
                  value,
                  label: value,
                }))}
              />
            </Form.Item>
            <Form.Item name="endUse" label="最终用途" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </div>
          <Form.Item name="technologyTags" label="技术参数标签">
            <Select
              mode="tags"
              placeholder="输入或选择技术参数"
              options={[
                '复合材料',
                '工艺参数',
                '工业控制',
                '加密算法',
                '半导体',
                '光刻',
                '精密运动控制',
              ].map((value) => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item name="personnelScopes" label="人员范围">
            <Select
              mode="multiple"
              options={['外籍人员', '第三方承包商', '双用途研发人员'].map((value) => ({
                value,
                label: value,
              }))}
            />
          </Form.Item>
          <Form.Item name="declarations" label="已提供声明">
            <Select
              mode="multiple"
              options={[
                '最终用户声明',
                '最终用途声明',
                '不扩散声明',
                '软件用途声明',
                '人员接触清单',
                '技术转移声明',
              ].map((value) => ({ value, label: value }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
