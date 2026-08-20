import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShipmentTable } from '../../../components/oms/ShipmentTable';

test('renders an activating native button with human status and honest full-value fallbacks', () => {
  const onSelect = jest.fn();
  render(<ShipmentTable rows={[{
    key: 'row-1', shipmentId: 'shipment-1', documentNumber: null, safeCode: null,
    stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS', updatedAt: 'invalid',
  }]} onSelect={onSelect} />);
  expect(screen.getByRole('button', { name: /shipment-1.*success/i })).toBeInTheDocument();
  expect(screen.getByTitle('shipment-1')).toBeInTheDocument();
  expect(screen.getByText('Document unavailable')).toBeInTheDocument();
  expect(screen.getByText('Safe code unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /shipment-1.*success/i }));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 'shipment-1' }));
});

test('does not claim list semantics without list item ownership and preserves supplied titles', () => {
  render(<ShipmentTable rows={[{
    key: 'row-2', shipmentId: 'shipment-2', documentNumber: 'INV-2', safeCode: 'SAFE_CODE',
    stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS', updatedAt: '2026-08-19T10:00:00.000Z',
  }]} />);
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  expect(screen.getByTitle('INV-2')).toBeInTheDocument();
  expect(screen.getByTitle('SAFE_CODE')).toBeInTheDocument();
});

test('activates a focused shipment row with Enter and Space', async () => {
  const user = userEvent.setup();
  const onSelect = jest.fn();
  render(<ShipmentTable rows={[{
    key: 'row-keyboard', shipmentId: 'shipment-keyboard', documentNumber: 'INV-K', safeCode: 'SAFE_K',
    stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS', updatedAt: '2026-08-19T10:00:00.000Z',
  }]} onSelect={onSelect} />);
  const row = screen.getByRole('button', { name: /shipment-keyboard.*success/i });

  row.focus();
  await user.keyboard('{Enter}');
  await user.keyboard(' ');

  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ shipmentId: 'shipment-keyboard' }));
});
