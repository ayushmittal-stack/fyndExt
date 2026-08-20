import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { OmsWorkspace } from '../../../components/oms/OmsWorkspace';
import { normalizeShipmentRow, QUEUE_IDS } from '../../../components/oms/omsModel';
import { useOmsWorkspaceData } from '../../../components/oms/useOmsWorkspaceData';
import { dryRunJourney, olderTimelinePage, shipmentPage, timelinePage } from './omsFixtures';
import * as dryRunApi from '../../../services/dryRunApi';
import * as shipmentActivityApi from '../../../services/shipmentActivityApi';

jest.mock('../../../services/dryRunApi', () => ({ getDryRunJourney: jest.fn(), getDryRunPodCurl: jest.fn(), getDryRunRequestBlob: jest.fn(), listDryRunFailures: jest.fn(), listDryRuns: jest.fn() }));
jest.mock('../../../services/shipmentActivityApi', () => ({ getShipmentTimeline: jest.fn(), listPreJobFailures: jest.fn(), listShipmentActivity: jest.fn() }));

function renderWorkspace() {
  return render(<MemoryRouter initialEntries={['/company/12/application/34']}><Routes><Route path="/company/:company_id/application/:application_id" element={<OmsWorkspace />} /></Routes></MemoryRouter>);
}
function unauthorized() { return Object.assign(new Error('expired'), { kind: 'unauthorized' }); }
function missing() { return Object.assign(new Error('missing'), { kind: 'not-found' }); }
function WorkspaceHarness({ companyId }) {
  const workspace = useOmsWorkspaceData({ companyId });
  return <><button type="button" onClick={() => workspace.selectRow(normalizeShipmentRow(shipmentPage.items[0]))}>Select shipment</button><button type="button" onClick={() => workspace.setActiveQueue(QUEUE_IDS.HELD)}>Held queue</button><button type="button" onClick={() => workspace.setActiveQueue(QUEUE_IDS.SHIPMENTS)}>Shipments queue</button><output data-testid="terminal-state">{workspace.terminal || 'active'}</output></>;
}

afterEach(() => { jest.resetAllMocks(); jest.useRealTimers(); });

test('selecting a shipment replaces the queue with its parallel evidence detail and Back keeps loaded rows', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue(timelinePage);
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  expect(screen.queryByLabelText('Loaded shipments')).not.toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Journey' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Evidence' })).toBeInTheDocument();
  expect(shipmentActivityApi.getShipmentTimeline).toHaveBeenCalledWith({ companyId: '12', shipmentId: 'shipment-100', limit: 50, before: null });
  expect(dryRunApi.getDryRunJourney).toHaveBeenCalledWith({ companyId: '12', jobId: 100 });
  fireEvent.click(screen.getByRole('button', { name: 'Back to Shipments' }));
  expect(screen.getByRole('button', { name: /shipment-100.*success/i })).toBeInTheDocument();
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
});

test('marks a long shipment heading for narrow-viewport wrapping', async () => {
  const shipmentId = '17869843904631069058';
  shipmentActivityApi.listShipmentActivity.mockResolvedValue({
    items: [{ ...shipmentPage.items[0], shipmentId }],
    nextBefore: null,
  });
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue({ ...timelinePage, shipmentId });
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  renderWorkspace();

  fireEvent.click(await screen.findByRole('button', { name: new RegExp(shipmentId) }));

  const heading = await screen.findByRole('heading', { name: shipmentId, level: 1 });
  expect(heading).toHaveClass('oms-detail-title');
  expect(screen.getByRole('main')).toHaveAccessibleName(shipmentId);
});

test('a row without a job loads only timeline evidence', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue({ items: [{ ...shipmentPage.items[0], shipmentId: 'shipment-no-job', jobId: null }], nextBefore: null });
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue({ ...timelinePage, shipmentId: 'shipment-no-job' });
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-no-job.*success/i }));
  await screen.findByRole('heading', { name: 'Overview' });
  expect(dryRunApi.getDryRunJourney).not.toHaveBeenCalled();
});

test('stale detail success and 401 cannot replace a newer selection', async () => {
  let firstResolve; let staleJourneyReject;
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline
    .mockImplementationOnce(() => new Promise(resolve => { firstResolve = resolve; }))
    .mockResolvedValueOnce({ ...timelinePage, shipmentId: 'shipment-99' });
  dryRunApi.getDryRunJourney
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { staleJourneyReject = reject; }))
    .mockResolvedValueOnce(dryRunJourney);
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Back to Shipments' }));
  fireEvent.click(screen.getByRole('button', { name: /shipment-99.*timeout/i }));
  await screen.findByRole('heading', { name: 'shipment-99', level: 1 });
  await act(async () => { firstResolve(timelinePage); staleJourneyReject(unauthorized()); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'shipment-99', level: 1 })).toBeInTheDocument();
});

test('detail Refresh reloads evidence only, retains verified evidence on transient failure, and reports its own refresh time', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValueOnce(timelinePage).mockRejectedValueOnce(new Error('failed'));
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await screen.findAllByText('OEIS_RETRY');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));
  expect(await screen.findByText('Could not refresh shipment evidence; verified evidence is still being shown.')).toBeInTheDocument();
  expect(screen.getAllByText('OEIS_RETRY')).not.toHaveLength(0);
  expect(screen.getByText(/Last refreshed/)).toBeInTheDocument();
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
});

test('timeline 404 retains the selected row while journey 404 remains journey-specific', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockRejectedValue(missing());
  dryRunApi.getDryRunJourney.mockRejectedValue(missing());
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  expect(await screen.findByText('Shipment evidence unavailable')).toBeInTheDocument();
  expect(screen.getByText('Journey evidence unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Shipments' }));
  expect(screen.getByRole('button', { name: /shipment-100.*success/i })).toBeInTheDocument();
});

test('timeline 404 retains independently verified journey evidence', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockRejectedValue(missing());
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await screen.findByText('Shipment evidence unavailable');
  expect(screen.getByText('Exact Fynd lock request')).toBeInTheDocument();
});

test('journey 404 retains independently verified timeline evidence', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue(timelinePage);
  dryRunApi.getDryRunJourney.mockRejectedValue(missing());
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await screen.findByText('Journey evidence unavailable');
  expect(screen.getByText('RETRY SCHEDULED')).toBeInTheDocument();
});

test('Refresh timeline 404 clears stale timeline evidence while retaining verified journey evidence', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValueOnce(timelinePage).mockRejectedValueOnce(missing());
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await screen.findByRole('heading', { name: 'Overview' });

  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));

  expect(await screen.findByText('Shipment evidence unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'View activity' })).not.toBeInTheDocument();
  expect(screen.getByText('Exact Fynd lock request')).toBeInTheDocument();
  expect(screen.queryByText(/verified evidence is still being shown/i)).not.toBeInTheDocument();
});

test('Refresh journey 404 clears stale journey evidence and its actions while retaining verified timeline evidence', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue(timelinePage);
  dryRunApi.getDryRunJourney.mockResolvedValueOnce(dryRunJourney).mockRejectedValueOnce(missing());
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await screen.findByRole('button', { name: 'Copy pod cURL' });

  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));

  expect(await screen.findByText('Journey evidence unavailable')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View activity' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download diagnostic JSON' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy pod cURL' })).not.toBeInTheDocument();
  expect(screen.queryByText(/verified evidence is still being shown/i)).not.toBeInTheDocument();
});

test('starts timeline and journey in parallel and keeps detail busy until both settle', async () => {
  let resolveTimeline; let resolveJourney;
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockImplementation(() => new Promise(resolve => { resolveTimeline = resolve; }));
  dryRunApi.getDryRunJourney.mockImplementation(() => new Promise(resolve => { resolveJourney = resolve; }));
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await act(async () => { await Promise.resolve(); });
  expect(shipmentActivityApi.getShipmentTimeline).toHaveBeenCalledTimes(1);
  expect(dryRunApi.getDryRunJourney).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Refresh detail' })).toBeDisabled();
  await act(async () => { resolveTimeline(timelinePage); });
  expect(screen.getByRole('button', { name: 'Refresh detail' })).toBeDisabled();
  await act(async () => { resolveJourney(dryRunJourney); });
  expect(screen.getByRole('button', { name: 'Refresh detail' })).toBeEnabled();
});

test('successful Refresh replaces both resources, updates its timestamp, and ignores duplicate clicks', async () => {
  const refreshedTimeline = { ...timelinePage, items: timelinePage.items.slice(0, 1), nextBefore: null };
  const refreshedJourney = { ...dryRunJourney, job: { ...dryRunJourney.job, documentNumber: 'INV-100-R' } };
  let resolveTimeline; let resolveJourney;
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-19T10:00:00.000Z'));
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValueOnce(timelinePage).mockImplementationOnce(() => new Promise(resolve => { resolveTimeline = resolve; }));
  dryRunApi.getDryRunJourney.mockResolvedValueOnce(dryRunJourney).mockImplementationOnce(() => new Promise(resolve => { resolveJourney = resolve; }));
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await screen.findAllByText('OEIS_RETRY');
  const before = screen.getByText(/Last refreshed/).textContent;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refreshing…' }));
  expect(shipmentActivityApi.getShipmentTimeline).toHaveBeenCalledTimes(2);
  expect(dryRunApi.getDryRunJourney).toHaveBeenCalledTimes(2);
  jest.setSystemTime(new Date('2026-08-19T10:00:01.000Z'));
  await act(async () => { resolveTimeline(refreshedTimeline); resolveJourney(refreshedJourney); });
  expect(screen.queryByText('OEIS_RETRY')).not.toBeInTheDocument();
  const lastRefreshed = screen.getByText(/Last refreshed/);
  expect(lastRefreshed.textContent).not.toBe(before);
  expect(lastRefreshed).toHaveAttribute('role', 'status');
  expect(lastRefreshed).toHaveAttribute('aria-live', 'polite');
  expect(lastRefreshed).toHaveAttribute('aria-atomic', 'true');
});

test('Refresh detail stays disabled while an older activity request remains pending after the drawer closes', async () => {
  let resolveOlder;
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue(timelinePage);
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await screen.findByRole('button', { name: 'View activity' });
  shipmentActivityApi.getShipmentTimeline.mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'View activity' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  expect(screen.getByRole('button', { name: 'Loading older activity…' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Close activity' }));
  expect(screen.getByRole('button', { name: 'Refresh detail' })).toBeDisabled();
  await act(async () => { resolveOlder(olderTimelinePage); });
  expect(screen.getByRole('button', { name: 'Refresh detail' })).toBeEnabled();
});

test('current detail 401 clears protected evidence and terminates this OMS mount', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockRejectedValue(unauthorized());
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
  expect(screen.queryByText('OEIS_RETRY')).not.toBeInTheDocument();
});

test('current journey 401 is terminal while queue ABA stale detail completions are ignored', async () => {
  let staleTimelineResolve; let staleJourneyReject;
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockImplementationOnce(() => new Promise(resolve => { staleTimelineResolve = resolve; }));
  dryRunApi.getDryRunJourney.mockImplementationOnce(() => new Promise((_resolve, reject) => { staleJourneyReject = reject; }));
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Back to Shipments' }));
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  fireEvent.click(screen.getByRole('tab', { name: /Shipments/ }));
  await act(async () => { staleTimelineResolve(timelinePage); staleJourneyReject(unauthorized()); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /shipment-100.*success/i })).toBeInTheDocument();

  shipmentActivityApi.getShipmentTimeline.mockResolvedValueOnce(timelinePage);
  dryRunApi.getDryRunJourney.mockRejectedValueOnce(unauthorized());
  fireEvent.click(screen.getByRole('button', { name: /shipment-100.*success/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
});

test('queue ABA without Back and a company route change both ignore stale timeline 401 responses', async () => {
  let queueTimelineReject; let routeTimelineReject;
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { queueTimelineReject = reject; }))
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { routeTimelineReject = reject; }));
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  const { rerender } = render(<WorkspaceHarness companyId="12" />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Select shipment' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Held queue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Shipments queue' }));
  await act(async () => { queueTimelineReject(unauthorized()); });
  expect(screen.getByTestId('terminal-state')).toHaveTextContent('active');

  fireEvent.click(screen.getByRole('button', { name: 'Select shipment' }));
  await act(async () => { await Promise.resolve(); });
  rerender(<WorkspaceHarness companyId="13" />);
  await act(async () => { routeTimelineReject(unauthorized()); });
  expect(screen.getByTestId('terminal-state')).toHaveTextContent('active');
});

test('initial failures use initial-error copy rather than retained-evidence warning', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockRejectedValue(new Error('failed'));
  dryRunApi.getDryRunJourney.mockRejectedValue(new Error('failed'));
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  expect(await screen.findByText('Could not load shipment evidence')).toBeInTheDocument();
  expect(screen.getByText('Could not load journey evidence')).toBeInTheDocument();
  expect(screen.queryByText(/verified evidence is still being shown/i)).not.toBeInTheDocument();
});

test('does not start deferred detail requests after the OMS mount is removed', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue(timelinePage);
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  const view = renderWorkspace();
  const row = await screen.findByRole('button', { name: /shipment-100.*success/i });
  fireEvent.click(row);
  view.unmount();
  await act(async () => Promise.resolve());
  expect(shipmentActivityApi.getShipmentTimeline).not.toHaveBeenCalled();
  expect(dryRunApi.getDryRunJourney).not.toHaveBeenCalled();
});

test('detail selection does not schedule work or add a visibility listener, and ignores completions after unmount', async () => {
  let resolveOlder;
  jest.useFakeTimers();
  const listenerSpy = jest.spyOn(document, 'addEventListener');
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValueOnce(timelinePage).mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }));
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
  const { unmount } = renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'View activity' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  expect(jest.getTimerCount()).toBe(0);
  expect(listenerSpy.mock.calls.some(([event]) => event === 'visibilitychange')).toBe(false);
  unmount();
  await act(async () => { resolveOlder(olderTimelinePage); });
});
