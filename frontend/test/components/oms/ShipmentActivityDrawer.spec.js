import React from 'react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { OmsWorkspace } from '../../../components/oms/OmsWorkspace';
import { dryRunJourney, olderTimelinePage, shipmentPage, timelinePage } from './omsFixtures';
import * as dryRunApi from '../../../services/dryRunApi';
import * as shipmentActivityApi from '../../../services/shipmentActivityApi';

jest.mock('../../../services/dryRunApi', () => ({ getDryRunJourney: jest.fn(), getDryRunPodCurl: jest.fn(), getDryRunRequestBlob: jest.fn(), listDryRunFailures: jest.fn(), listDryRuns: jest.fn() }));
jest.mock('../../../services/shipmentActivityApi', () => ({ getShipmentTimeline: jest.fn(), listPreJobFailures: jest.fn(), listShipmentActivity: jest.fn() }));

function renderDetail() { return render(<div className="extension-experience-root is-oms"><button type="button">Classic</button><MemoryRouter initialEntries={['/company/12/application/34']}><Routes><Route path="/company/:company_id/application/:application_id" element={<OmsWorkspace />} /></Routes></MemoryRouter></div>); }
function deferred() { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function openDrawer() {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue(timelinePage);
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  renderDetail();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  const trigger = await screen.findByRole('button', { name: 'View activity' });
  fireEvent.click(trigger);
  return trigger;
}
afterEach(() => jest.resetAllMocks());

test('portal drawer owns its OMS tokens and border-box viewport sizing', () => {
  const css = readFileSync(resolve(__dirname, '../../../components/oms/oms.css'), 'utf8');
  const drawerRule = css.match(/\.oms-activity-drawer\s*\{([^}]*)\}/s)?.[1] || '';
  expect(drawerRule).toMatch(/--oms-border:\s*#[0-9a-f]+/i);
  expect(drawerRule).toMatch(/--oms-ink:\s*#[0-9a-f]+/i);
  expect(drawerRule).toMatch(/--oms-muted:\s*#[0-9a-f]+/i);
  expect(drawerRule).toMatch(/box-sizing:\s*border-box/);
  expect(css).toMatch(/\.oms-activity-drawer\s+\*\s*\{[^}]*box-sizing:\s*border-box/s);
});

test('activity trigger opens a labelled modal with focus trap, Escape close, and trigger restoration', async () => {
  const user = userEvent.setup();
  const trigger = await openDrawer();
  const dialog = screen.getByRole('dialog', { name: 'Shipment activity' });
  expect(dialog).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close activity' })).toHaveFocus();
  const background = document.querySelector('.extension-experience-root');
  expect(background).toHaveAttribute('aria-hidden', 'true');
  expect(background).toHaveAttribute('inert');
  expect(background.inert).toBe(true);
  await user.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'Load older activity' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Close activity' })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(background).not.toHaveAttribute('aria-hidden');
  expect(background).not.toHaveAttribute('inert');
  expect(background.inert).toBe(false);
  expect(trigger).toHaveFocus();
});

test('restores focus when the drawer closes while older activity is still loading', async () => {
  const older = deferred();
  shipmentActivityApi.getShipmentTimeline.mockResolvedValueOnce(timelinePage).mockReturnValueOnce(older.promise);
  const trigger = await openDrawer();
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  expect(screen.getByRole('button', { name: 'Loading older activity…' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Shipment activity' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toBeEnabled();
  expect(trigger).toHaveFocus();
  await act(async () => { older.resolve(olderTimelinePage); });
});

test('loads older exact-cursor evidence chronologically without overlaps and retains it after failure', async () => {
  shipmentActivityApi.getShipmentTimeline.mockResolvedValueOnce(timelinePage).mockResolvedValueOnce(olderTimelinePage).mockRejectedValueOnce(new Error('failed'));
  await openDrawer();
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  await screen.findByText('Local validation passed');
  expect(shipmentActivityApi.getShipmentTimeline).toHaveBeenLastCalledWith({ companyId: '12', shipmentId: 'shipment-100', limit: 50, before: 'timeline-cursor-100' });
  expect(screen.getAllByText('Webhook received')).toHaveLength(1);
  expect(screen.getAllByRole('listitem').map(item => item.textContent).join(' | ')).toMatch(/Local validation passed.*Webhook received.*Fynd invoice lock confirmed/);
  expect(screen.queryByRole('button', { name: 'Load older activity' })).not.toBeInTheDocument();
});

test('older activity 401 is terminal and unmount restores the isolated extension root', async () => {
  shipmentActivityApi.getShipmentTimeline.mockResolvedValueOnce(timelinePage).mockRejectedValueOnce(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
  await openDrawer();
  const root = document.querySelector('.extension-experience-root');
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
  expect(root).not.toHaveAttribute('aria-hidden');
});

test('drawer unmount restores pre-existing background attributes and properties', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue(timelinePage);
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  const { unmount } = renderDetail();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'View activity' }));
  const root = document.querySelector('.extension-experience-root');
  expect(root.inert).toBe(true);
  unmount();
  expect(root).not.toHaveAttribute('aria-hidden');
  expect(root).not.toHaveAttribute('inert');
  expect(root.inert).toBe(false);
});

test('failed older request retains activity and retries the same cursor successfully', async () => {
  shipmentActivityApi.getShipmentTimeline.mockResolvedValueOnce(timelinePage).mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(olderTimelinePage);
  await openDrawer();
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  expect(await screen.findByText('Could not load older activity. You can try again.')).toBeInTheDocument();
  expect(screen.getByText('Fynd invoice lock confirmed')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Load older activity' })).toBeEnabled();
  expect(shipmentActivityApi.getShipmentTimeline).toHaveBeenLastCalledWith({ companyId: '12', shipmentId: 'shipment-100', limit: 50, before: 'timeline-cursor-100' });
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  expect(await screen.findByText('Local validation passed')).toBeInTheDocument();
  expect(shipmentActivityApi.getShipmentTimeline).toHaveBeenLastCalledWith({ companyId: '12', shipmentId: 'shipment-100', limit: 50, before: 'timeline-cursor-100' });
});
