import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShipmentQueueTabs } from '../../../components/oms/ShipmentQueueTabs';

function TabHost() {
  const [activeQueue, setActiveQueue] = React.useState('shipments');
  return <ShipmentQueueTabs activeQueue={activeQueue} counts={{ shipments: 2, held: 0, failures: 0 }} onChange={setActiveQueue} />;
}

test('uses roving tabs that activate and focus with arrow, home, and end keys', () => {
  const onChange = jest.fn();
  render(<ShipmentQueueTabs activeQueue="shipments" counts={{ shipments: 2, held: 0, failures: 0 }} onChange={onChange} />);
  const shipments = screen.getByRole('tab', { name: /Shipments/ });
  fireEvent.keyDown(shipments, { key: 'ArrowRight' });
  expect(onChange).toHaveBeenLastCalledWith('held');
  fireEvent.keyDown(shipments, { key: 'End' });
  expect(onChange).toHaveBeenLastCalledWith('failures');
  fireEvent.keyDown(shipments, { key: 'Home' });
  expect(onChange).toHaveBeenLastCalledWith('shipments');
  expect(shipments).toHaveAttribute('aria-selected', 'true');
});

test('moves actual focus and roving tabIndex when it activates a tab', () => {
  render(<TabHost />);
  const shipments = screen.getByRole('tab', { name: /Shipments/ });
  const held = screen.getByRole('tab', { name: /Held/ });
  shipments.focus();
  fireEvent.keyDown(shipments, { key: 'ArrowRight' });
  expect(held).toHaveFocus();
  expect(held).toHaveAttribute('aria-selected', 'true');
  expect(held).toHaveAttribute('tabIndex', '0');
  expect(shipments).toHaveAttribute('tabIndex', '-1');
});
