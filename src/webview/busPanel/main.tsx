import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/emberTheme.css';
import { BusMonitorApp } from './BusMonitorApp';
import { installNumberWheel } from '../shared/numberWheel';

installNumberWheel();

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<BusMonitorApp />);
}
