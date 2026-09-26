import { Navigate, Route, BrowserRouter, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AuthGate } from './AuthGate';
import { AppShell } from './layout/AppShell';
import { OrdersPage } from './pages/orders/OrdersPage';
import { LoadSheetLogsPage } from './pages/orders/LoadSheetLogsPage';
import { InventoryPage } from './pages/inventory/InventoryPage';
import { ProductAnalyticsPage } from './pages/analytics/ProductAnalyticsPage';
import { CityAnalyticsPage } from './pages/analytics/CityAnalyticsPage';
import { TransactionsPage } from './pages/finance/TransactionsPage';
import { LedgersPage } from './pages/finance/LedgersPage';
import { LedgerDetailPage } from './pages/finance/LedgerDetailPage';
import { TrialBalancePage } from './pages/finance/TrialBalancePage';
import { BillsPage } from './pages/finance/BillsPage';
import { OrderFulfillmentPage } from './pages/fulfillment/OrderFulfillmentPage';
import { LocalDeliveriesPage } from './pages/fulfillment/LocalDeliveriesPage';
import { PrintAirwayBillPage } from './pages/fulfillment/PrintAirwayBillPage';
import { ScanBarcodePage } from './pages/fulfillment/ScanBarcodePage';
import { CourierPaymentReportPage } from './pages/fulfillment/CourierPaymentReportPage';
import { CourierPerformancePage } from './pages/fulfillment/CourierPerformancePage';
import { DashboardPage } from './pages/dashboard/DashboardPage';
import { MonthSummaryPage } from './pages/dashboard/MonthSummaryPage';
import { MonthDetailPage } from './pages/dashboard/MonthDetailPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { AdminPortal } from './pages/admin/AdminPortal';

function LoadingScreen() {
  return (
    <div className="loading-screen" style={{ display: 'flex' }}>
      <div className="loading-content">
        <img src="/assets/Logo_Large.png" alt="QuikMerchant" className="loading-logo" />
        <div className="loading-spinner" />
        <p>Loading your data...</p>
      </div>
    </div>
  );
}

/** `/` lands on the first section this org actually has enabled, rather than assuming
 * Orders - a finance-only org would otherwise land on a hidden/blocked view. */
function DefaultRedirect() {
  const { hasFeature } = useAuth();
  // PWA shortcuts (manifest.json) land on /?action=create-entry|bulk-entry. Carried as
  // router state, not a query param, so refresh/back doesn't re-open the modal.
  const action = new URLSearchParams(useLocation().search).get('action');
  if (hasFeature('finance') && (action === 'create-entry' || action === 'bulk-entry')) {
    return <Navigate to="/transactions" state={{ entryMode: action === 'bulk-entry' ? 'bulk' : 'single' }} replace />;
  }
  const to = hasFeature('orders') ? '/orders' : hasFeature('finance') ? '/transactions' : '/settings';
  return <Navigate to={to} replace />;
}

function AuthedRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DefaultRedirect />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="order-fulfillment" element={<OrderFulfillmentPage />} />
        <Route path="local-deliveries" element={<LocalDeliveriesPage />} />
        <Route path="print-airway-bill" element={<PrintAirwayBillPage />} />
        <Route path="scan-barcode" element={<ScanBarcodePage />} />
        <Route path="products" element={<InventoryPage />} />
        <Route path="product-analytics" element={<ProductAnalyticsPage />} />
        <Route path="city-analytics" element={<CityAnalyticsPage />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="ledgers" element={<LedgersPage />} />
        <Route path="ledgers/:id" element={<LedgerDetailPage />} />
        <Route path="bills" element={<BillsPage />} />
        <Route path="trial-balance" element={<TrialBalancePage />} />
        <Route path="courier-payment-report" element={<CourierPaymentReportPage />} />
        <Route path="courier-payment-report/:id" element={<CourierPaymentReportPage />} />
        <Route path="courier-performance" element={<CourierPerformancePage />} />
        <Route path="load-sheet-logs" element={<LoadSheetLogsPage />} />
        <Route path="month-summary" element={<MonthSummaryPage />} />
        <Route path="month-summary/:month" element={<MonthDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<DefaultRedirect />} />
      </Route>
    </Routes>
  );
}

function MainApp() {
  const { status } = useAuth();

  if (status === 'loading') return <LoadingScreen />;
  if (status === 'gate') return <AuthGate />;
  return <AuthedRoutes />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Own login/token, deliberately outside useAuth()'s gate - see AdminPortal.tsx */}
        <Route path="/admin/*" element={<AdminPortal />} />
        <Route path="/*" element={<MainApp />} />
      </Routes>
    </BrowserRouter>
  );
}
