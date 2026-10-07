import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
  message,
} from 'antd'
import { FileAddOutlined, HistoryOutlined, SaveOutlined } from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import {
  useAddFileVersionMutation,
  useCreatePackageVersionMutation,
  useGetWorkspaceQuery,
  useSaveFileMutation,
  useSavePackageMutation,
  useSetReferenceVersionMutation,
  useValidatePackageMutation,
} from '@/app/api'
import type { FileVersion, MaterialCategory, MaterialFile } from '@/types/domain'
import { categoryLabels } from '@/services/mockData'
import { poolUsage, reservationStatusLabels } from '@/services/quota'

interface PackageFormValues {
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

interface FileDraftValues {
  name: string
  kind: MaterialCategory
  pageCount: number
  summary: string
}

export function PackageEditorPage() {
  const { packageId = '' } = useParams()
  const navigate = useNavigate()
  const [packageForm] = Form.useForm<PackageFormValues>()
  const [fileForm] = Form.useForm<FileDraftValues>()
  const [versionForm] = Form.useForm<{ label: string; pageCount: number; summary: string }>()
  const [packageVersionForm] = Form.useForm<{ label: string; summary: string }>()
  const [fileModal, setFileModal] = useState(false)
  const [versionModalFile, setVersionModalFile] = useState<MaterialFile>()
  const [packageVersionModal, setPackageVersionModal] = useState(false)
  const { data, isLoading } = useGetWorkspaceQuery()
  const [savePackage, saveState] = useSavePackageMutation()
  const [saveFile, fileState] = useSaveFileMutation()
  const [addFileVersion, versionState] = useAddFileVersionMutation()
  const [setReferenceVersion] = useSetReferenceVersionMutation()
  const [createPackageVersion, packageVersionState] = useCreatePackageVersionMutation()
  const [validatePackage, validateState] = useValidatePackageMutation()

  const packageItem = useMemo(
    () => data?.packages.find((item) => item.id === packageId),
    [data, packageId],
  )
  const files = useMemo(
    () => data?.files.filter((file) => file.packageId === packageId) ?? [],
    [data, packageId],
  )

  useEffect(() => {
    if (!packageItem) return
    packageForm.setFieldsValue({
      title: packageItem.title,
      category: packageItem.category,
      applicant: packageItem.applicant,
      recipient: packageItem.recipient,
      destination: packageItem.destination,
      endUse: packageItem.endUse,
      technologyTags: packageItem.technologyTags,
      personnelScopes: packageItem.personnelScopes,
      declarations: packageItem.declarations,
    })
  }, [packageForm, packageItem])

  if (isLoading || !data) return <div className="panel">正在加载资料包...</div>
  if (!packageItem) {
    return (
      <div className="panel">
        <Alert type="error" showIcon message="资料包不存在或已被移除。" />
      </div>
    )
  }

  const rule = data.rules.find((item) => item.id === packageItem.matchedRuleId)
  const packageFindings = data.findings.filter((item) => item.packageId === packageId)
  const { settled: poolSettled, held: poolHeld } = rule
    ? poolUsage(data.reservations, rule.id)
    : { settled: 0, held: 0 }
  const activeReservation = data.reservations.find(
    (item) => item.id === packageItem.activeReservationId && item.status === 'held',
  )

  async function savePackageInfo() {
    const values = await packageForm.validateFields()
    const result = await savePackage({ packageId, patch: values }).unwrap()
    const matched = result.packages.find((item) => item.id === packageId)
    message.success(`资料包信息已保存，当前匹配：${result.rules.find((item) => item.id === matched?.matchedRuleId)?.name ?? '无规则'}`)
  }

  async function submitFile() {
    const values = await fileForm.validateFields()
    const version: FileVersion = {
      id: `file-version-${crypto.randomUUID()}`,
      label: 'V1.0',
      uploadedAt: new Date().toISOString(),
      hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
      sizeKb: values.pageCount * 96 + 720,
      pages: Array.from({ length: values.pageCount }, (_, index) => ({
        id: `page-${crypto.randomUUID()}`,
        page: index + 1,
        category: values.kind,
        controlled: false,
        desensitized: false,
        note: '',
        reviewer: '',
      })),
      changeSummary: values.summary,
    }
    const file: MaterialFile = {
      id: `file-${crypto.randomUUID()}`,
      packageId,
      name: values.name,
      kind: values.kind,
      activeVersionId: version.id,
      referencedVersionId: version.id,
      versions: [version],
    }
    await saveFile({ file }).unwrap()
    message.success('文件已登记并建立初始版本')
    fileForm.resetFields()
    setFileModal(false)
  }

  async function submitFileVersion() {
    if (!versionModalFile) return
    const values = await versionForm.validateFields()
    await addFileVersion({
      packageId,
      fileId: versionModalFile.id,
      ...values,
    }).unwrap()
    message.success('新文件版本已建立，逐页分类需要重新完成')
    setVersionModalFile(undefined)
    versionForm.resetFields()
  }

  async function submitPackageVersion() {
    const values = await packageVersionForm.validateFields()
    await createPackageVersion({ packageId, ...values }).unwrap()
    message.success('资料包版本快照已创建')
    setPackageVersionModal(false)
    packageVersionForm.resetFields()
  }

  async function runValidation() {
    const result = await validatePackage({ packageId }).unwrap()
    const count = result.findings.filter((item) => item.packageId === packageId).length
    message.success(`许可匹配校验完成，共 ${count} 项结论`)
  }

  const tabItems = [
    {
      key: 'files',
      label: `资料文件 (${files.length})`,
      children: (
        <div>
          <div className="panel-title">
            <div>
              <h3>拆解与版本管理</h3>
              <span className="muted">同一资料文件只能选择一个审批引用版本。</span>
            </div>
            <Button icon={<FileAddOutlined />} onClick={() => setFileModal(true)}>
              登记本地文件
            </Button>
          </div>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {files.map((file) => {
              const activeVersion =
                file.versions.find((version) => version.id === file.activeVersionId) ??
                file.versions[0]
              const referencedVersion =
                file.versions.find((version) => version.id === file.referencedVersionId) ??
                activeVersion
              return (
                <div className="version-box" key={file.id}>
                  <div className="panel-title" style={{ marginBottom: 10 }}>
                    <div>
                      <strong>{file.name}</strong>
                      <div className="muted">
                        {categoryLabels[file.kind]} · {file.versions.length} 个版本 · 当前{' '}
                        {activeVersion.pages.length} 页
                      </div>
                    </div>
                    <Space>
                      <Button
                        size="small"
                        onClick={() => {
                          setVersionModalFile(file)
                          versionForm.setFieldsValue({
                            label: `V${file.versions.length + 0.1}`,
                            pageCount: activeVersion.pages.length,
                            summary: '',
                          })
                        }}
                      >
                        上传新版本
                      </Button>
                      <Button
                        type="primary"
                        ghost
                        size="small"
                        onClick={() => navigate(`/page-review?package=${packageId}&file=${file.id}`)}
                      >
                        逐页核对
                      </Button>
                    </Space>
                  </div>
                  <Space wrap>
                    <span>现行版本</span>
                    <Tag color="blue">{activeVersion.label}</Tag>
                    <span>审批引用</span>
                    <Select
                      size="small"
                      value={referencedVersion.id}
                      style={{ width: 160 }}
                      options={file.versions.map((version) => ({
                        value: version.id,
                        label: `${version.label} · ${version.hash}`,
                      }))}
                      onChange={async (versionId) => {
                        await setReferenceVersion({ fileId: file.id, versionId }).unwrap()
                        message.success('审批引用版本已更新并留痕')
                      }}
                    />
                    {referencedVersion.id !== activeVersion.id ? (
                      <Tag color="error">存在版本错配</Tag>
                    ) : (
                      <Tag color="success">引用一致</Tag>
                    )}
                  </Space>
                </div>
              )
            })}
            {!files.length ? <Alert type="info" showIcon message="尚未登记资料文件。" /> : null}
          </Space>
        </div>
      ),
    },
    {
      key: 'versions',
      label: `资料包版本 (${packageItem.versions.length})`,
      children: (
        <div>
          <div className="panel-title">
            <h3>资料包快照</h3>
            <Button icon={<HistoryOutlined />} onClick={() => setPackageVersionModal(true)}>
              创建新版本
            </Button>
          </div>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {[...packageItem.versions].reverse().map((version) => (
              <div className="version-box" key={version.id}>
                <Space>
                  <Tag color="blue">{version.label}</Tag>
                  <strong>{version.summary}</strong>
                  <span className="muted">
                    {version.createdBy} · {new Date(version.createdAt).toLocaleString('zh-CN')}
                  </span>
                </Space>
                <div className="muted" style={{ marginTop: 8 }}>
                  技术标签：{version.snapshot.technologyTags.join('、') || '无'}；声明：
                  {version.snapshot.declarations.join('、') || '无'}
                </div>
              </div>
            ))}
          </Space>
        </div>
      ),
    },
    {
      key: 'rule',
      label: '规则解释',
      children: rule ? (
        <div>
          <Alert
            type="info"
            showIcon
            message={rule.name}
            description={rule.explanation}
            style={{ marginBottom: 14 }}
          />
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <strong>必要声明</strong>
              <div style={{ marginTop: 8 }}>
                {rule.requiredDeclarations.map((declaration) => (
                  <Tag
                    key={declaration}
                    color={packageItem.declarations.includes(declaration) ? 'success' : 'error'}
                  >
                    {declaration}
                  </Tag>
                ))}
              </div>
            </div>
            <div>
              <strong>审批等级</strong>
              <div className="muted" style={{ marginTop: 5 }}>
                {rule.approvalLevel === 'senior'
                  ? '高级审批'
                  : rule.approvalLevel === 'enhanced'
                    ? '升级审批'
                    : '标准审批'}
              </div>
            </div>
            <div>
              <strong>许可额度</strong>
              <div className="muted" style={{ marginTop: 5 }}>
                规则池实占 {poolSettled} / 预占 {poolHeld}（上限 {rule.quotaLimit}）
                {activeReservation ? `；本包在途预占 ${activeReservation.amount}` : ''}
              </div>
            </div>
          </Space>
        </div>
      ) : (
        <Alert type="warning" showIcon message="当前没有匹配规则，请先执行许可校验。" />
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={packageItem.title}
        description={`${packageItem.code} · 申请人 ${packageItem.applicant} · 目的地 ${packageItem.destination}`}
        actions={
          <>
            <StatusTag status={packageItem.status} />
            <Button
              loading={validateState.isLoading}
              onClick={runValidation}
            >
              执行许可校验
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saveState.isLoading}
              onClick={savePackageInfo}
            >
              保存
            </Button>
          </>
        }
      />

      {packageFindings.some((item) => item.level === 'high') ? (
        <Alert
          type="error"
          showIcon
          message={`存在 ${packageFindings.filter((item) => item.level === 'high').length} 项高风险结论`}
          description={packageFindings
            .filter((item) => item.level === 'high')
            .map((item) => item.message)
            .join('；')}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {packageItem.pendingConflict || packageItem.quotaBlocked ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="版本/参数变化导致预占重算"
          description={
            packageItem.pendingConflict?.reason ??
            packageItem.quotaBlocked?.reason ??
            '未完成审批的旧预占已失效，请前往审批页查看冲突或缺额。'
          }
        />
      ) : activeReservation ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`审批在途，已按规则上限预占 ${activeReservation.amount}`}
          description="现行版本、引用版本或技术参数一旦变化，未完成步骤的预占将失效并按新版本重算；已通过步骤保留原依据。"
        />
      ) : null}

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>申报信息</h3>
            <span className="muted">变更保存后重新匹配许可规则</span>
          </div>
          <Form form={packageForm} layout="vertical">
            <Form.Item name="title" label="资料包名称" rules={[{ required: true }]}>
              <Input />
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
              <Input />
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
            <Form.Item name="technologyTags" label="技术参数">
              <Select
                mode="tags"
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
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>合规快照</h3>
            <Tag color={rule ? 'success' : 'error'}>{rule ? '已匹配规则' : '未匹配规则'}</Tag>
          </div>
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <div>
              <span className="muted">当前状态</span>
              <div>
                <StatusTag status={packageItem.status} />
              </div>
            </div>
            <div>
              <span className="muted">审批轮次</span>
              <div>{packageItem.currentRound ? `第 ${packageItem.currentRound} 轮` : '未提交'}</div>
            </div>
            <div>
              <span className="muted">许可额度（共享池）</span>
              <div>
                实占 {poolSettled} · 预占 {poolHeld} / {rule?.quotaLimit ?? packageItem.quotaLimit}
                {activeReservation ? (
                  <Tag color="processing" style={{ marginLeft: 8 }}>
                    {reservationStatusLabels.held} {activeReservation.amount}
                  </Tag>
                ) : null}
              </div>
            </div>
            <div>
              <span className="muted">最近更新</span>
              <div>{new Date(packageItem.updatedAt).toLocaleString('zh-CN')}</div>
            </div>
            <div>
              <span className="muted">核对结果</span>
              <div>
                高 {packageFindings.filter((item) => item.level === 'high').length} · 中{' '}
                {packageFindings.filter((item) => item.level === 'medium').length}
              </div>
            </div>
          </Space>
        </section>
      </div>

      <section className="panel">
        <Tabs items={tabItems} />
      </section>

      <Modal
        title="登记本地资料文件"
        open={fileModal}
        onCancel={() => setFileModal(false)}
        onOk={submitFile}
        confirmLoading={fileState.isLoading}
        okText="登记文件"
        cancelText="取消"
      >
        <Form
          form={fileForm}
          layout="vertical"
          initialValues={{ kind: packageItem.category, pageCount: 1 }}
        >
          <Form.Item name="name" label="文件名称" rules={[{ required: true }]}>
            <Input placeholder="例如 工艺规程-V1.pdf" />
          </Form.Item>
          <Form.Item name="kind" label="资料分类" rules={[{ required: true }]}>
            <Select
              options={Object.entries(categoryLabels).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item name="pageCount" label="页数或文件项数" rules={[{ required: true }]}>
            <InputNumber min={1} max={500} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="summary" label="版本说明" rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`上传新版本：${versionModalFile?.name ?? ''}`}
        open={Boolean(versionModalFile)}
        onCancel={() => setVersionModalFile(undefined)}
        onOk={submitFileVersion}
        confirmLoading={versionState.isLoading}
        okText="建立版本"
        cancelText="取消"
      >
        <Form form={versionForm} layout="vertical">
          <Form.Item name="label" label="版本号" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="pageCount" label="页数或文件项数" rules={[{ required: true }]}>
            <InputNumber min={1} max={500} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="summary" label="变更说明" rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
        <Alert
          type="warning"
          showIcon
          message="新版本不会复用旧版本逐页分类结果，必须重新核对。"
        />
      </Modal>

      <Modal
        title="创建资料包版本"
        open={packageVersionModal}
        onCancel={() => setPackageVersionModal(false)}
        onOk={submitPackageVersion}
        confirmLoading={packageVersionState.isLoading}
        okText="创建版本"
        cancelText="取消"
      >
        <Form form={packageVersionForm} layout="vertical">
          <Form.Item name="label" label="版本号" rules={[{ required: true }]}>
            <Input placeholder="例如 V1.2" />
          </Form.Item>
          <Form.Item name="summary" label="版本说明" rules={[{ required: true }]}>
            <Input.TextArea rows={3} placeholder="说明申报信息、文件引用或声明变更" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
