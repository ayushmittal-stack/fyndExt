import React from 'react';

export function JsonPanel({ title, value, children, open = true }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  return (
    <details className="dry-run-panel" open={open}>
      <summary className="dry-run-panel-summary">
        <h3>{title}</h3>
      </summary>
      {children}
      <pre className="dry-run-code"><code>{text}</code></pre>
    </details>
  );
}
