import React from 'react';
import { render, screen } from '@testing-library/react';

import { OmsStateView } from '../../../components/oms/OmsStateView';
import { ShipmentStatusChip } from '../../../components/oms/ShipmentStatusChip';

test.each([
  ['SUCCESS', 'Success', 'success'], ['FAILURE', 'Failure', 'failure'], ['TIMEOUT', 'Timeout', 'timeout'],
  ['HELD', 'Held', 'held'], ['RETRY_SCHEDULED', 'Retry scheduled', 'info'],
  ['STARTED', 'Started', 'started'], ['INDETERMINATE', 'Indeterminate', 'indeterminate'],
])('renders %s with status text and a %s tone', (outcome, label, tone) => {
  render(<ShipmentStatusChip outcome={outcome} />);
  const chip = screen.getByText(label);
  expect(chip).toHaveClass(`oms-status-chip--${tone}`);
});

test('uses appropriate live region semantics for workspace states', () => {
  const { rerender } = render(<OmsStateView kind="warning" title="Retained rows" message="Try refresh again." />);
  expect(screen.getByRole('status')).toHaveTextContent('Retained rows');

  rerender(<OmsStateView kind="unauthorized" title="Session expired" message="Reauthenticate." />);
  expect(screen.getByRole('alert')).toHaveTextContent('Session expired');

  rerender(<OmsStateView kind="loading" title="Loading shipments" message="Please wait." />);
  const loader = screen.getByRole('status');
  expect(loader).toHaveAttribute('aria-live', 'polite');
  expect(loader).toHaveAttribute('aria-atomic', 'true');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
