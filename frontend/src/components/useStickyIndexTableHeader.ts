import { useLayoutEffect } from 'react';

// Polaris's own IndexTable sticky header (its <Sticky>/StickyManager) only pins the header
// when the *page* scrolls past it - it renders its sticky duplicate outside the table's own
// scroll box, so it never reacts to an internal overflow:auto container like ours (see
// .orders-table-card .Polaris-IndexTable-ScrollContainer). It also floats via
// position:fixed with app-measured left/width, which doesn't track a <table>'s column
// widths - fine for their div-based duplicate header, not for our real header/filter <tr>s.
// CSS position:sticky is the right primitive for "stick within this scroll container", so we
// keep it, but borrow their StickyManager technique of stacking sticky rows by the measured
// height of whichever ones are above it, recomputed on resize (their manageStickyItems).
// `rootSelector` scopes the lookup to the page's view wrapper; `hasRows` matters because the
// real <thead> only exists once IndexTable has rows to show (itemCount>0) - it renders an
// empty-state placeholder instead while still loading, so re-running only on selection would
// leave this stuck at the initial "no thead yet" no-op forever.
export function useStickyIndexTableHeader(rootSelector: string, hasRows: boolean) {
  useLayoutEffect(() => {
    const thead = document.querySelector(`${rootSelector} .Polaris-IndexTable thead`) as HTMLElement | null;
    const tableRoot = document.querySelector(`${rootSelector} .Polaris-IndexTable`) as HTMLElement | null;
    const filtersRow = document.getElementById('__filters__');
    if (!thead || !tableRoot || !filtersRow) return;
    const recalcStickyOffsets = () => {
      // Raw fractional height (e.g. 40.4375), not rounded - this is also the filter row's
      // natural, pre-scroll resting position (right after thead in normal flow), so matching it
      // exactly means the row doesn't visibly snap to a different offset the moment it engages
      // position:sticky right as you start scrolling. Rounding this up (tried previously) was
      // an attempt to fix the header/filter seam here, but that's not the right place for it -
      // it just made the row's stuck position land below its own natural rest position, which
      // is the snap the user reported. The seam itself is handled by the ::before backdrop
      // below. Set on the IndexTable root, not the scroll container: Polaris renders its
      // loading panel as a *sibling* of the scroll container (see .Polaris-IndexTable__LoadingPanel
      // in styles.css), and it needs these same offsets to sit below the header/filter rows
      // rather than over them - the root is the nearest ancestor all three inherit from.
      const theadH = thead.getBoundingClientRect().height;
      const filtersH = filtersRow.getBoundingClientRect().height;
      tableRoot.style.setProperty('--orders-sticky-top', `${theadH}px`);
      // The backdrop also needs the filter row's own height, to cover down to *its* bottom
      // edge (see .Polaris-IndexTable-ScrollContainer::before) - the filter row's per-cell
      // border-bottom isn't enough on its own: it's a separate position:sticky box per column,
      // and Chrome occasionally mis-renders that whole row a frame late while scrolling (its
      // real bug, not just a rounding gap - confirmed via screenshot, a scrolled-away row's
      // content briefly painting where the filter row and its border should be). The backdrop
      // is one plain sticky div, not N independently-composited cells, so it doesn't glitch the
      // same way and reliably backstops the border regardless of what the filter row does.
      tableRoot.style.setProperty('--orders-sticky-filters-height', `${filtersH}px`);
      // A plain block child of the scroll container defaults to *its* (viewport-clamped) width,
      // not the wider <table>'s full column width - so on a horizontal scroll the backdrop fell
      // short of the columns scrolled into view instead of panning with them like a real row
      // would. thead already spans the table's true full width (columns line up under it
      // correctly), so borrow that width for the backdrop too.
      tableRoot.style.setProperty('--orders-sticky-backdrop-width', `${thead.getBoundingClientRect().width}px`);
    };
    recalcStickyOffsets();
    const observer = new ResizeObserver(recalcStickyOffsets);
    observer.observe(thead);
    observer.observe(filtersRow);
    return () => observer.disconnect();
  }, [rootSelector, hasRows]);
}
