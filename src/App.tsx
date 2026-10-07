import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#237b78',
          borderRadius: 4,
          fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
        },
        components: {
          Layout: {
            siderBg: '#19324a',
            headerBg: '#ffffff',
          },
          Menu: {
            darkItemBg: '#19324a',
            darkItemSelectedBg: '#285c70',
          },
        },
      }}
    >
      <RouterProvider router={router} />
    </ConfigProvider>
  )
}
