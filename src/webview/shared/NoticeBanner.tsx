import React from 'react';
import { dismissNotice, NoticeItem } from './clientStore';

export const NoticeBanner: React.FC<{
  notice: NoticeItem;
  actionLabel?: string;
  onAction?: () => void;
}> = ({ notice, actionLabel, onAction }) => {
  return (
    <div className={`ep-notice ${notice.level}`} role="status">
      <div className="ep-notice-head">
        <span className="ep-notice-text">{notice.text}</span>
        <div className="ep-notice-actions">
          {actionLabel && onAction && (
            <button type="button" className="ep-btn secondary mini" onClick={onAction}>
              {actionLabel}
            </button>
          )}
          <button
            type="button"
            className="ep-btn ghost mini"
            onClick={() => dismissNotice(notice.id)}
            title="关闭提示"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
};

export const PillSwitch: React.FC<{
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}> = ({ checked, disabled, onChange, title }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    title={title}
    className="pill-switch"
    onClick={() => onChange(!checked)}
  >
    <span />
  </button>
);
