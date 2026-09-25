import { StrictMode } from 'react';
import type { ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { NavLink } from 'react-router-dom';
import '@fortawesome/fontawesome-free/css/all.min.css';
import '@shopify/polaris/build/esm/styles.css';
import { AppProvider } from '@shopify/polaris';
import type { AppProviderProps } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import './styles.css';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './toast/ToastContext';
import { ConfirmProvider } from './components/ConfirmContext';
import { App } from './App';
import { InstallAppBanner } from './InstallAppBanner';

type PolarisLinkProps = ComponentProps<NonNullable<AppProviderProps['linkComponent']>>;

// Routes Polaris's own url-based nav (Navigation.Item, via Frame) through the router instead of a full reload.
// NavLink for its aria-current="page", which the mobile drawer's highlight keys off (see styles.css).
function PolarisLink({ url, ...rest }: PolarisLinkProps) {
  return <NavLink to={url} {...rest} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider i18n={enTranslations} linkComponent={PolarisLink}>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <App />
            <InstallAppBanner />
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </AppProvider>
  </StrictMode>,
);
