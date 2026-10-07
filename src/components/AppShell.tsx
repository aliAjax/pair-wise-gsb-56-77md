import {
  AuditOutlined,
  DashboardOutlined,
  DiffOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  SafetyCertificateOutlined,
  SolutionOutlined,
} from '@ant-design/icons'
import { Avatar, Layout, Menu, Tag, Typography } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useGetWorkspaceQuery } from '@/app/api'

const { Sider, Header, Content } = Layout

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '运行总览' },
  { key: '/packages', icon: <FileTextOutlined />, label: '资料包' },
  { key: '/page-review', icon: <FileSearchOutlined />, label: '逐页核对' },
  { key: '/approvals', icon: <SolutionOutlined />, label: '审批路线' },
  { key: '/licenses', icon: <SafetyCertificateOutlined />, label: '许可与额度' },
  { key: '/versions', icon: <DiffOutlined />, label: '版本差异' },
  { key: '/audit', icon: <AuditOutlined />, label: '审计与导出' },
]

export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const { isFetching } = useGetWorkspaceQuery()
  const activePath =
    menuItems
      .map((item) => item.key)
      .filter((key) => key !== '/' && location.pathname.startsWith(key))
      .sort((left, right) => right.length - left.length)[0] ?? '/'

  return (
    <Layout className="app-shell">
      <Sider width={236} theme="dark" className="app-sider">
        <div className="brand">
          <div className="brand-mark">控</div>
          <div>
            <strong>出口管制审批</strong>
            <span>技术资料合规工作台</span>
          </div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[activePath]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
        <div className="sider-foot">
          <span>当前政策集</span>
          <strong>2026 出口管制规则集</strong>
          <small>本地模拟数据已持久化</small>
        </div>
      </Sider>
      <Layout>
        <Header className="app-header">
          <div>
            <Typography.Text type="secondary" className="header-context">
              出口管制技术资料审批与许可核对平台
            </Typography.Text>
            <Typography.Title level={4}>资料审批控制台</Typography.Title>
          </div>
          <div className="header-user">
            <Tag color={isFetching ? 'gold' : 'green'}>{isFetching ? '正在同步' : '数据已同步'}</Tag>
            <Avatar>合</Avatar>
            <span>合规专员</span>
          </div>
        </Header>
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
