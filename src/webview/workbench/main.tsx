import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/emberTheme.css';
import { WorkbenchApp } from './WorkbenchApp';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<WorkbenchApp />);
}
