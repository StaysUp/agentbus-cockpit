import React from 'react';
import ReactDOM from 'react-dom/client';
import Cockpit from './Cockpit';
import './styles/base.css';
import './styles/app.css';
import './styles/markdown.css';
import './styles/narrow.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Cockpit />
  </React.StrictMode>
);
