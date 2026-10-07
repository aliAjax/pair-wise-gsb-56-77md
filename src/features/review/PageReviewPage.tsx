import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { CheckOutlined, SafetyOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useGetWorkspaceQuery,
  useSavePageReviewMutation,
  useValidatePackageMutation,
} from '@/app/api'
import type { MaterialCategory, PageReview } from '@/types/domain'
import { categoryLabels } from '@/services/mockData'

export function PageReviewPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [savePageReview, saveState] = useSavePageReviewMutation()
  const [validatePackage] = useValidatePackageMutation()
  const [selectedPackageId, setSelectedPackageId] = useState(searchParams.get('package') ?? '')
  const [selectedFileId, setSelectedFileId] = useState(searchParams.get('file') ?? '')
  const [selectedRows, setSelectedRows] = useState<React.Key[]>([])
  const [pages, setPages] = useState<PageReview[]>([])

  const packageFiles = useMemo(
    () => data?.files.filter((file) => file.packageId === selectedPackageId) ?? [],
    [data, selectedPackageId],
  )
  const selectedFile = packageFiles.find((file) => file.id === selectedFileId)
  const activeVersion = selectedFile?.versions.find(
    (version) => version.id === selectedFile.activeVersionId,
  )

  useEffect(() => {
    if (!selectedPackageId && data?.packages[0]) {
      setSelectedPackageId(data.packages[0].id)
    }
  }, [data, selectedPackageId])

  useEffect(() => {
    if (!packageFiles.some((file) => file.id === selectedFileId) && packageFiles[0]) {
      setSelectedFileId(packageFiles[0].id)
    }
  }, [packageFiles, selectedFileId])

  useEffect(() => {
    setPages(
      activeVersion?.pages.map((page) => ({ ...page })) ?? [],
    )
    setSelectedRows([])
    const next = new URLSearchParams(searchParams)
    if (selectedPackageId) next.set('package', selectedPackageId)
    if (selectedFileId) next.set('file', selectedFileId)
    setSearchParams(next, { replace: true })
  }, [activeVersion, searchParams, selectedFileId, selectedPackageId, setSearchParams])

  if (isLoading || !data) return <div className="panel">正在加载逐页核对工作区...</div>

  const currentFindings = data.findings.filter((item) => item.packageId === selectedPackageId)
  const reviewedCount = pages.filter((page) => page.reviewedAt).length

  function patchPages(ids: React.Key[], patch: Partial<PageReview>) {
    setPages((current) =>
      current.map((page) =>
        ids.includes(page.id)
          ? {
              ...page,
              ...patch,
            }
          : page,
      ),
    )
  }

  async function saveRows(ids: React.Key[]) {
    if (!selectedFile || !activeVersion) return
    for (const id of ids) {
      const page = pages.find((item) => item.id === id)
      if (!page) continue
      await savePageReview({
        fileId: selectedFile.id,
        versionId: activeVersion.id,
        page: {
          ...page,
          reviewer: '当前用户',
          reviewedAt: new Date().toISOString(),
        },
      }).unwrap()
    }
    message.success(`已保存 ${ids.length} 页的核对结果`)
    setSelectedRows([])
  }

  const columns: TableColumnsType<PageReview> = [
    {
      title: '页码',
      dataIndex: 'page',
      width: 75,
      render: (page: number, record) => (
        <span className={record.reviewedAt ? '' : 'finding-message'}>第 {page} 页</span>
      ),
    },
    {
      title: '资料分类',
      dataIndex: 'category',
      width: 145,
      render: (value: MaterialCategory, record) => (
        <Select
          value={value}
          style={{ width: 125 }}
          options={Object.entries(categoryLabels).map(([option, label]) => ({
            value: option,
            label,
          }))}
          onChange={(next) =>
            patchPages([record.id], { category: next as MaterialCategory, reviewedAt: undefined })
          }
        />
      ),
    },
    {
      title: '受控技术',
      dataIndex: 'controlled',
      width: 110,
      render: (value: boolean, record) => (
        <Switch
          checked={value}
          checkedChildren="受控"
          unCheckedChildren="一般"
          onChange={(next) =>
            patchPages([record.id], { controlled: next, reviewedAt: undefined })
          }
        />
      ),
    },
    {
      title: '脱敏状态',
      dataIndex: 'desensitized',
      width: 120,
      render: (value: boolean, record) => (
        <Switch
          checked={value}
          disabled={!record.controlled}
          checkedChildren="已脱敏"
          unCheckedChildren="待脱敏"
          onChange={(next) =>
            patchPages([record.id], { desensitized: next, reviewedAt: undefined })
          }
        />
      ),
    },
    {
      title: '核对说明',
      dataIndex: 'note',
      render: (value: string, record) => (
        <Input
          value={value}
          placeholder="记录受控依据、脱敏要求或一般资料判断"
          onChange={(event) =>
            patchPages([record.id], { note: event.target.value, reviewedAt: undefined })
          }
        />
      ),
    },
    {
      title: '核对状态',
      dataIndex: 'reviewedAt',
      width: 150,
      render: (value: string | undefined, record) => (
        <Space direction="vertical" size={2}>
          <Tag color={value ? 'success' : 'warning'}>{value ? '已核对' : '待核对'}</Tag>
          {value ? (
            <span className="muted">
              {record.reviewer} · {new Date(value).toLocaleDateString('zh-CN')}
            </span>
          ) : null}
        </Space>
      ),
    },
    {
      title: '操作',
      width: 100,
      fixed: 'right',
      render: (_, record) => (
        <Button type="link" loading={saveState.isLoading} onClick={() => saveRows([record.id])}>
          保存本页
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="逐页分类核对"
        description="对现行版本逐页确认资料分类、受控技术属性和脱敏状态；新版本必须重新核对。"
        actions={
          <>
            <Button
              icon={<SafetyOutlined />}
              onClick={async () => {
                await validatePackage({ packageId: selectedPackageId }).unwrap()
                message.success('资料包规则校验已刷新')
              }}
            >
              重新校验
            </Button>
            <Button
              type="primary"
              icon={<CheckOutlined />}
              disabled={!selectedRows.length}
              loading={saveState.isLoading}
              onClick={() => saveRows(selectedRows)}
            >
              批量确认选中页
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <Select
          value={selectedPackageId || undefined}
          placeholder="选择资料包"
          style={{ width: 300 }}
          onChange={(value) => {
            setSelectedPackageId(value)
            setSelectedFileId('')
          }}
          options={data.packages.map((item) => ({
            value: item.id,
            label: `${item.code} · ${item.title}`,
          }))}
        />
        <Select
          value={selectedFileId || undefined}
          placeholder="选择文件"
          style={{ width: 260 }}
          onChange={setSelectedFileId}
          options={packageFiles.map((file) => ({
            value: file.id,
            label: `${file.name} · ${file.versions.find((version) => version.id === file.activeVersionId)?.label ?? ''}`,
          }))}
        />
        <span className="grow" />
        <Tag>{reviewedCount} / {pages.length} 页已核对</Tag>
        {activeVersion ? <Tag color="blue">现行版本 {activeVersion.label}</Tag> : null}
      </div>

      {selectedFile && selectedFile.referencedVersionId !== selectedFile.activeVersionId ? (
        <Alert
          type="error"
          showIcon
          message="审批引用版本与文件现行版本不一致，当前资料包将被阻断。"
          style={{ marginBottom: 14 }}
        />
      ) : null}

      <div className="three-column">
        <section className="panel">
          <div className="panel-title">
            <h3>批量标记</h3>
            <span className="muted">{selectedRows.length} 页已选</span>
          </div>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button
              block
              disabled={!selectedRows.length}
              onClick={() => patchPages(selectedRows, { controlled: true })}
            >
              标记为受控技术
            </Button>
            <Button
              block
              disabled={!selectedRows.length}
              onClick={() => patchPages(selectedRows, { controlled: false, desensitized: false })}
            >
              标记为一般资料
            </Button>
            <Button
              block
              disabled={!selectedRows.length}
              onClick={() => patchPages(selectedRows, { desensitized: true })}
            >
              标记为已脱敏
            </Button>
          </Space>
          <Alert
            type="info"
            showIcon
            message="批量修改只是本地草稿，仍需要保存后才会写入版本审计。"
            style={{ marginTop: 14 }}
          />
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>{selectedFile?.name ?? '请选择文件'}</h3>
            {activeVersion ? <Tag>{activeVersion.hash}</Tag> : null}
          </div>
          <Table
            className="page-review-table"
            rowKey="id"
            loading={isLoading}
            columns={columns}
            dataSource={pages}
            scroll={{ x: 1050 }}
            pagination={false}
            rowClassName={(record) => (record.reviewedAt ? '' : 'pending-page')}
            rowSelection={{
              selectedRowKeys: selectedRows,
              onChange: setSelectedRows,
            }}
          />
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>当前校验结论</h3>
            <Tag color={currentFindings.some((item) => item.level === 'high') ? 'error' : 'success'}>
              {currentFindings.length} 项
            </Tag>
          </div>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {currentFindings.map((finding) => (
              <Alert
                key={finding.id}
                type={finding.level === 'high' ? 'error' : finding.level === 'medium' ? 'warning' : 'info'}
                showIcon
                message={finding.message}
                description={finding.action}
              />
            ))}
            {!currentFindings.length ? (
              <Alert type="success" showIcon message="当前没有校验问题。" />
            ) : null}
          </Space>
        </section>
      </div>
    </div>
  )
}
