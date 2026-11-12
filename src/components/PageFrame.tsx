import React from 'react';
import { follow, PAGE_PATHS } from '../page';

interface PageFrameProps {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}

// PageFrame is a page of its own beside the cockpit: a "← Cockpit" link
// back, the page's title, and its body.
export const PageFrame: React.FC<PageFrameProps> = ({ title, onBack, children }) => (
  <div id="page" className="page" aria-label={title}>
    <header className="page-head">
      <a className="page-back" href={PAGE_PATHS.cockpit} onClick={follow(onBack)}>
        ← Cockpit
      </a>
      <h1 className="page-title">{title}</h1>
    </header>
    <div className="page-body">{children}</div>
  </div>
);
