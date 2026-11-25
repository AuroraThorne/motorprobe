import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/emberTheme.css';
import { SidebarApp } from './SidebarApp';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<SidebarApp />);
}
