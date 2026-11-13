import React from 'react';

// The back button in a column's header on a narrow screen: it moves one
// column back (styles/narrow.css shows it only under 900px).
export const BackButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button type="button" className="col-back btn btn-quiet" onClick={onClick} aria-label={`Back to ${label}`} title={`Back to ${label}`}>
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 4l-4 4 4 4" />
    </svg>
    <span>{label}</span>
  </button>
);
