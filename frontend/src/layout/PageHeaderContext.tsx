// Lets each routed page declare the header's title/subtitle/toolbar, replacing
// navigation.js's switchView(), which used to imperatively show/hide ~15
// per-view header divs. AppShell renders whatever the current page sets here.
//
// Two separate contexts, not one: `setHeader` (from useState) is referentially
// stable across renders, but the `header` value itself changes every time a
// page calls it. If a page consumed a single context carrying both, it would
// re-render on its own `setHeader` call (since the header value changed) and
// re-run its `usePageHeader` effect with a brand new `actions` JSX reference,
// calling `setHeader` again - an infinite loop. Splitting them means
// `usePageHeader` (used by pages) only subscribes to the stable setter, and
// `useCurrentPageHeader` (used only by AppShell's <Header>) is the one place
// that actually re-renders when the header content changes.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface PageHeader {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Centered search box, for pages whose table filters live-as-you-type on it. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
}

type SetHeader = (header: PageHeader) => void;

const PageHeaderValueContext = createContext<PageHeader | null>(null);
const PageHeaderSetterContext = createContext<SetHeader | null>(null);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [header, setHeader] = useState<PageHeader>({ title: '' });
  return (
    <PageHeaderSetterContext.Provider value={setHeader}>
      <PageHeaderValueContext.Provider value={header}>{children}</PageHeaderValueContext.Provider>
    </PageHeaderSetterContext.Provider>
  );
}

/** Call from a routed page component to set the header for as long as it's mounted. */
export function usePageHeader(header: PageHeader): void {
  const setHeader = useContext(PageHeaderSetterContext);
  if (!setHeader) throw new Error('usePageHeader() used outside <PageHeaderProvider>');
  const { title, subtitle, actions, search } = header;
  const { value: searchValue, onChange: onSearchChange, placeholder: searchPlaceholder } = search ?? {};
  useEffect(() => {
    setHeader({ title, subtitle, actions, search: onSearchChange ? { value: searchValue ?? '', onChange: onSearchChange, placeholder: searchPlaceholder } : undefined });
  }, [setHeader, title, subtitle, actions, searchValue, onSearchChange, searchPlaceholder]);
}

/** Used by AppShell only, to read what the current page set. */
export function useCurrentPageHeader(): PageHeader {
  const value = useContext(PageHeaderValueContext);
  if (!value) throw new Error('useCurrentPageHeader() used outside <PageHeaderProvider>');
  return value;
}
