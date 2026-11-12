import React from 'react';
import { follow, PAGE_PATHS } from '../page';

interface PageFrameProps {
  title: string;
  onBack: () => void;
  // The left column: the list to pick from, and a quiet note at its foot.
  list: React.ReactNode;
  foot?: React.ReactNode;
  // The middle column (what was picked) and the right one (its detail).
  main: React.ReactNode;
  side: React.ReactNode;
}

// PageFrame is a page of its own beside the cockpit, in the mockup's three
// columns: a list with the page's title and a "Cockpit" link back, then what
// was picked, then its detail. Each column scrolls on its own.
export const PageFrame: React.FC<PageFrameProps> = ({ title, onBack, list, foot, main, side }) => (
  <div id="page" className="page" aria-label={title}>
    <aside className="pg-list">
      <header className="colhead">
        <h1 className="colhead-title">{title}</h1>
        <a className="btn btn-quiet page-back" href={PAGE_PATHS.cockpit} onClick={follow(onBack)}>
          <BackIcon />
          Cockpit
        </a>
      </header>
      <div className="colbody">{list}</div>
      {foot && <div className="pg-foot">{foot}</div>}
    </aside>
    <main className="pg-main">{main}</main>
    <section className="pg-side">{side}</section>
  </div>
);

// ColHead is a column's 72px header row: a title, a quiet note after it, and
// an action on the right.
export const ColHead: React.FC<{ title: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode }> = ({
  title,
  sub,
  action,
}) => (
  <header className="colhead">
    <div className="colhead-title">
      {title}
      {sub && <span className="ch-sub">{sub}</span>}
    </div>
    {action}
  </header>
);

const BackIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 4L6 8l4 4" />
  </svg>
);
