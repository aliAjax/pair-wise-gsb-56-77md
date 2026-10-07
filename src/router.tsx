import { Navigate, createBrowserRouter } from 'react-router-dom'
import { AppShell } from '@/components/AppShell'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { PackageListPage } from '@/features/packages/PackageListPage'
import { PackageEditorPage } from '@/features/packages/PackageEditorPage'
import { PageReviewPage } from '@/features/review/PageReviewPage'
import { ApprovalPage } from '@/features/approval/ApprovalPage'
import { LicensePage } from '@/features/license/LicensePage'
import { VersionDiffPage } from '@/features/versions/VersionDiffPage'
import { AuditPage } from '@/features/audit/AuditPage'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'packages', element: <PackageListPage /> },
      { path: 'packages/:packageId', element: <PackageEditorPage /> },
      { path: 'page-review', element: <PageReviewPage /> },
      { path: 'approvals', element: <ApprovalPage /> },
      { path: 'licenses', element: <LicensePage /> },
      { path: 'versions', element: <VersionDiffPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
