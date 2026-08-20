import React from 'react';

export function OmsStateView({ kind, title, message }) {
  const isUnauthorized = kind === 'unauthorized';
  const isLoading = kind === 'loading';
  return (
    <section
      className={`oms-state-view oms-state-view--${kind}`}
      role={isUnauthorized ? 'alert' : 'status'}
      aria-live={isUnauthorized ? undefined : 'polite'}
      aria-atomic={isLoading ? 'true' : undefined}
    >
      <h2>{title}</h2>
      <p>{message}</p>
    </section>
  );
}
