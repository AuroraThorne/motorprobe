import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/emberTheme.css';
import { SidebarApp } from './SidebarApp';
import { installNumberWheel } from '../shared/numberWheel';

installNumberWheel();

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<SidebarApp />);
}
