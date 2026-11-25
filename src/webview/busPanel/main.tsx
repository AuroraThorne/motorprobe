import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/emberTheme.css';
import { BusMonitorApp } from './BusMonitorApp';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<BusMonitorApp />);
}
