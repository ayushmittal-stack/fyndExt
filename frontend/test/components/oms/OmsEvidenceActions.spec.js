import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

import { OmsWorkspace } from '../../../components/oms/OmsWorkspace';
import { normalizeShipmentRow } from '../../../components/oms/omsModel';
import { useOmsWorkspaceData } from '../../../components/oms/useOmsWorkspaceData';
import { dryRunJourney, shipmentPage, timelinePage } from './omsFixtures';
import * as dryRunApi from '../../../services/dryRunApi';
import * as shipmentActivityApi from '../../../services/shipmentActivityApi';

jest.mock('../../../services/dryRunApi', () => ({ getDryRunJourney: jest.fn(), getDryRunPodCurl: jest.fn(), getDryRunRequestBlob: jest.fn(), listDryRunFailures: jest.fn(), listDryRuns: jest.fn() }));
jest.mock('../../../services/shipmentActivityApi', () => ({ getShipmentTimeline: jest.fn(), listPreJobFailures: jest.fn(), listShipmentActivity: jest.fn() }));

const ENVELOPE = Object.freeze({
  method: 'POST', url: "https://oeis.example.test/root'quoted/API/V2/Transaction/UpdateInvoiceData",
  requestJson: '[{"NOTE":"O\'Reilly $HOME $(id) `uname`"}]', requestHash: 'b'.repeat(64), byteCount: 45,
  apiKey: "live'key$HOME $(id)",
});
const EXPECTED_CURL = [
  'curl --silent --show-error --max-redirs 0 \\', '  --request POST \\',
  "  --url 'https://oeis.example.test/root'\"'\"'quoted/API/V2/Transaction/UpdateInvoiceData' \\",
  "  --header 'Authorization: APIkey live'\"'\"'key$HOME $(id)' \\",
  "  --header 'Connection: keep-alive' \\", "  --header 'Content-Type: application/json' \\",
  "  --data-binary '[{\"NOTE\":\"O'\"'\"'Reilly $HOME $(id) `uname`\"}]'",
].join('\n');

function deferred() { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function cloneJourney(mutate = () => {}) { const result = JSON.parse(JSON.stringify(dryRunJourney)); mutate(result); return result; }
function RoutedWorkspace() { const navigate = useNavigate(); return <><button type="button" onClick={() => navigate('/company/13/application/34')}>Change route</button><OmsWorkspace /></>; }
function renderWorkspace() { return render(<MemoryRouter initialEntries={['/company/12/application/34']}><Routes><Route path="/company/:company_id/application/:application_id" element={<RoutedWorkspace />} /></Routes></MemoryRouter>); }
async function openDetail() { fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*success/i })); await screen.findByRole('heading', { name: 'Evidence' }); }
function DirectActionHarness() {
  const workspace = useOmsWorkspaceData({ companyId: '12' });
  return <>
    <button type="button" onClick={() => workspace.selectRow(normalizeShipmentRow(shipmentPage.items[0]))}>Direct select</button>
    <button type="button" onClick={workspace.refresh}>Direct queue refresh</button>
    <button type="button" onClick={workspace.refreshDetail}>Direct detail refresh</button>
    <button type="button" onClick={workspace.downloadDiagnostic}>Direct download</button>
    <button type="button" onClick={workspace.copyPodCurl}>Direct copy</button>
    <output>{workspace.detailView.journey ? 'Journey ready' : 'Journey absent'}</output>
    <output data-testid="direct-terminal">{workspace.terminal || ''}</output>
    <output data-testid="direct-action-feedback">{workspace.evidenceActions.feedback.message}</output>
  </>;
}

beforeEach(() => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue(timelinePage);
  dryRunApi.getDryRunJourney.mockResolvedValue(cloneJourney());
  dryRunApi.getDryRunRequestBlob.mockResolvedValue(new Blob(['exact bytes'], { type: 'application/json' }));
  dryRunApi.getDryRunPodCurl.mockResolvedValue(ENVELOPE);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined });
});
afterEach(() => { jest.restoreAllMocks(); jest.resetAllMocks(); jest.useRealTimers(); delete navigator.clipboard; delete document.execCommand; });

test('shows download only for a loaded journey with a diagnostic body filename', async () => {
  renderWorkspace(); await openDetail();
  expect(screen.getByRole('button', { name: 'Download diagnostic JSON' })).toBeInTheDocument();

  dryRunApi.getDryRunJourney.mockResolvedValueOnce(cloneJourney(value => { delete value.steps.oeisSubmission.bodyFileName; }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to Shipments' }));
  fireEvent.click(screen.getByRole('button', { name: /shipment-99.*timeout/i }));
  await screen.findByRole('heading', { name: 'shipment-99', level: 1 });
  expect(screen.queryByRole('button', { name: 'Download diagnostic JSON' })).not.toBeInTheDocument();
});

test('does not expose diagnostic download for a non-dry-run journey', async () => {
  dryRunApi.getDryRunJourney.mockResolvedValue(cloneJourney(value => { value.mode = 'live'; }));
  renderWorkspace(); await openDetail();
  expect(screen.queryByRole('button', { name: 'Download diagnostic JSON' })).not.toBeInTheDocument();
  expect(dryRunApi.getDryRunRequestBlob).not.toHaveBeenCalled();
});

test.each([
  ['mode', value => { value.mode = 'live'; }],
  ['job state', value => { value.job.state = 'COMPLETED'; }],
  ['lock status', value => { value.steps.fyndLock.status = 'pending'; }],
  ['locked result', value => { value.steps.fyndLock.result.locked = false; }],
  ['OEIS status', value => { value.steps.oeisSubmission.status = 'completed'; }],
])('shows Copy pod cURL only when exact eligibility holds: %s', async (_name, mutate) => {
  dryRunApi.getDryRunJourney.mockResolvedValue(cloneJourney(mutate));
  renderWorkspace(); await openDetail();
  expect(screen.queryByRole('button', { name: 'Copy pod cURL' })).not.toBeInTheDocument();
  expect(screen.queryByText(/real OEIS submission/i)).not.toBeInTheDocument();
  expect(dryRunApi.getDryRunPodCurl).not.toHaveBeenCalled();
});

test('precedes an eligible Copy control with prominent duplicate-invoice safety copy and no forbidden mutations', async () => {
  const { container } = renderWorkspace(); await openDetail();
  const warning = screen.getByRole('note', { name: 'Real submission warning' });
  expect(warning).toHaveTextContent(/performs a real OEIS submission/i);
  expect(warning).toHaveTextContent(/run the copied command only once/i);
  expect(warning).toHaveTextContent(/duplicate invoice/i);
  expect(screen.getByRole('button', { name: 'Copy pod cURL' })).toHaveAttribute('aria-describedby', warning.id);
  ['Retry', 'Reprocess', 'Unlock', 'Approve', 'Submit', 'Import', 'Reconcile', 'Invoice transition'].forEach(name => expect(screen.queryByRole('button', { name: new RegExp(name, 'i') })).not.toBeInTheDocument());
  expect(container).not.toHaveTextContent(ENVELOPE.url);
  expect(container).not.toHaveTextContent(ENVELOPE.apiKey);
  expect(container).not.toHaveTextContent(ENVELOPE.requestJson);
});

test('disables both evidence actions and rejects direct action starts during any detail request', async () => {
  const refreshedJourney = deferred();
  dryRunApi.getDryRunJourney.mockResolvedValueOnce(cloneJourney()).mockReturnValueOnce(refreshedJourney.promise);
  renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));
  expect(screen.getByRole('button', { name: 'Download diagnostic JSON' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Copy pod cURL' })).toBeDisabled();
  refreshedJourney.resolve(cloneJourney());
  await screen.findByRole('button', { name: 'Refresh detail' });

  dryRunApi.getDryRunJourney.mockResolvedValueOnce(cloneJourney()).mockReturnValueOnce(deferred().promise);
  const direct = render(<DirectActionHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Direct select' }));
  expect(await screen.findByText('Journey ready')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Direct detail refresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Direct download' }));
  fireEvent.click(screen.getByRole('button', { name: 'Direct copy' }));
  expect(dryRunApi.getDryRunRequestBlob).not.toHaveBeenCalled();
  expect(dryRunApi.getDryRunPodCurl).not.toHaveBeenCalled();
  direct.unmount();
});

test.each([
  ['job ID', value => { value.job.jobId = 101; }],
  ['request hash', value => { value.steps.payloadPreparation.requestHash = 'c'.repeat(64); }],
  ['body filename', value => { value.steps.oeisSubmission.bodyFileName = 'INV-100-rebuilt-request.json'; }],
])('invalidates a pending download when Refresh changes its %s identity', async (_name, mutate) => {
  const blob = deferred(); const refreshedJourney = deferred();
  dryRunApi.getDryRunRequestBlob.mockReturnValueOnce(blob.promise);
  dryRunApi.getDryRunJourney.mockResolvedValueOnce(cloneJourney()).mockReturnValueOnce(refreshedJourney.promise);
  const createObjectURL = jest.fn(() => 'blob:stale-identity');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));
  refreshedJourney.resolve(cloneJourney(mutate));
  blob.resolve(new Blob(['stale']));
  await act(async () => Promise.resolve());
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(screen.queryByText('Diagnostic JSON downloaded')).not.toBeInTheDocument();
});

test('invalidates a pending download when Refresh removes dry-run eligibility while Copy remains ineligible', async () => {
  const blob = deferred(); const refreshedJourney = deferred();
  const nonCopyDryRun = cloneJourney(value => { value.job.state = 'COMPLETED'; });
  dryRunApi.getDryRunRequestBlob.mockReturnValueOnce(blob.promise);
  dryRunApi.getDryRunJourney.mockResolvedValueOnce(nonCopyDryRun).mockReturnValueOnce(refreshedJourney.promise);
  const createObjectURL = jest.fn(() => 'blob:stale-mode');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  renderWorkspace(); await openDetail();
  expect(screen.queryByRole('button', { name: 'Copy pod cURL' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));
  refreshedJourney.resolve(cloneJourney(value => { value.job.state = 'COMPLETED'; value.mode = 'live'; }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Download diagnostic JSON' })).not.toBeInTheDocument());
  blob.resolve(new Blob(['stale mode']));
  await act(async () => Promise.resolve());
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(screen.queryByText('Diagnostic JSON downloaded')).not.toBeInTheDocument();
});

test.each([
  ['mode', value => { value.mode = 'live'; }],
  ['job state', value => { value.job.state = 'COMPLETED'; }],
  ['lock status', value => { value.steps.fyndLock.status = 'pending'; }],
  ['locked result', value => { value.steps.fyndLock.result.locked = false; }],
  ['OEIS status', value => { value.steps.oeisSubmission.status = 'completed'; }],
])('invalidates a pending copy when Refresh changes %s eligibility', async (_name, mutate) => {
  const envelope = deferred(); const refreshedJourney = deferred();
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  dryRunApi.getDryRunPodCurl.mockReturnValueOnce(envelope.promise);
  dryRunApi.getDryRunJourney.mockResolvedValueOnce(cloneJourney()).mockReturnValueOnce(refreshedJourney.promise);
  renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Copy pod cURL' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));
  refreshedJourney.resolve(cloneJourney(mutate));
  envelope.resolve(ENVELOPE);
  await act(async () => Promise.resolve());
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.queryByText('Pod cURL copied')).not.toBeInTheDocument();
});

test('ignores a stale copy 401 after Refresh changes the evidence identity', async () => {
  const envelope = deferred(); const refreshedJourney = deferred();
  dryRunApi.getDryRunPodCurl.mockReturnValueOnce(envelope.promise);
  dryRunApi.getDryRunJourney.mockResolvedValueOnce(cloneJourney()).mockReturnValueOnce(refreshedJourney.promise);
  renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Copy pod cURL' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));
  refreshedJourney.resolve(cloneJourney(value => { value.steps.payloadPreparation.requestHash = 'd'.repeat(64); }));
  envelope.reject(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
  await act(async () => Promise.resolve());
  expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
});

test('Download 401 synchronously excludes and invalidates a concurrent Copy completion', async () => {
  const blob = deferred(); const envelope = deferred();
  const writeText = jest.fn().mockResolvedValue(undefined);
  const createObjectURL = jest.fn(() => 'blob:must-not-exist');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  dryRunApi.getDryRunRequestBlob.mockReturnValueOnce(blob.promise);
  dryRunApi.getDryRunPodCurl.mockReturnValueOnce(envelope.promise);
  render(<DirectActionHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Direct select' }));
  expect(await screen.findByText('Journey ready')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Direct download' }));
  fireEvent.click(screen.getByRole('button', { name: 'Direct copy' }));
  expect(dryRunApi.getDryRunRequestBlob).toHaveBeenCalledTimes(1);
  blob.reject(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
  envelope.resolve(ENVELOPE);
  await act(async () => Promise.resolve());
  expect(dryRunApi.getDryRunPodCurl).not.toHaveBeenCalled();
  expect(screen.getByTestId('direct-terminal')).toHaveTextContent('unauthorized');
  expect(writeText).not.toHaveBeenCalled();
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByTestId('direct-action-feedback')).toBeEmptyDOMElement();
});

test('Copy 401 synchronously excludes and invalidates a concurrent Download completion', async () => {
  const envelope = deferred(); const blob = deferred();
  const writeText = jest.fn().mockResolvedValue(undefined);
  const createObjectURL = jest.fn(() => 'blob:must-not-exist');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  dryRunApi.getDryRunPodCurl.mockReturnValueOnce(envelope.promise);
  dryRunApi.getDryRunRequestBlob.mockReturnValueOnce(blob.promise);
  render(<DirectActionHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Direct select' }));
  expect(await screen.findByText('Journey ready')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Direct copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Direct download' }));
  expect(dryRunApi.getDryRunPodCurl).toHaveBeenCalledTimes(1);
  envelope.reject(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
  blob.resolve(new Blob(['stale concurrent download']));
  await act(async () => Promise.resolve());
  expect(dryRunApi.getDryRunRequestBlob).not.toHaveBeenCalled();
  expect(screen.getByTestId('direct-terminal')).toHaveTextContent('unauthorized');
  expect(writeText).not.toHaveBeenCalled();
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByTestId('direct-action-feedback')).toBeEmptyDOMElement();
});

test('Copy 404 synchronously excludes and invalidates a concurrent Download completion', async () => {
  const envelope = deferred(); const blob = deferred();
  const createObjectURL = jest.fn(() => 'blob:must-not-exist');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  dryRunApi.getDryRunPodCurl.mockReturnValueOnce(envelope.promise);
  dryRunApi.getDryRunRequestBlob.mockReturnValueOnce(blob.promise);
  render(<DirectActionHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Direct select' }));
  expect(await screen.findByText('Journey ready')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Direct copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Direct download' }));
  expect(dryRunApi.getDryRunPodCurl).toHaveBeenCalledTimes(1);
  envelope.reject(Object.assign(new Error('gone'), { kind: 'not-found' }));
  blob.resolve(new Blob(['stale concurrent download']));
  await act(async () => Promise.resolve());
  expect(dryRunApi.getDryRunRequestBlob).not.toHaveBeenCalled();
  expect(screen.getByText('Journey absent')).toBeInTheDocument();
  expect(screen.getByTestId('direct-terminal')).toBeEmptyDOMElement();
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByTestId('direct-action-feedback')).toBeEmptyDOMElement();
});

test('a current queue 401 synchronously blocks a same-turn pending diagnostic download', async () => {
  const queue = deferred(); const blob = deferred();
  const createObjectURL = jest.fn(() => 'blob:must-not-exist');
  shipmentActivityApi.listShipmentActivity.mockResolvedValueOnce(shipmentPage).mockReturnValueOnce(queue.promise);
  dryRunApi.getDryRunRequestBlob.mockReturnValueOnce(blob.promise);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  render(<DirectActionHarness />);
  await waitFor(() => expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Direct queue refresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Direct select' }));
  expect(await screen.findByText('Journey ready')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Direct download' }));
  expect(dryRunApi.getDryRunRequestBlob).toHaveBeenCalledTimes(1);

  await act(async () => {
    queue.reject(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
    blob.resolve(new Blob(['must remain private']));
    await Promise.resolve();
  });

  expect(screen.getByTestId('direct-terminal')).toHaveTextContent('unauthorized');
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByTestId('direct-action-feedback')).toBeEmptyDOMElement();
});

test('a current queue 401 synchronously blocks a same-turn pending pod-cURL copy', async () => {
  const queue = deferred(); const envelope = deferred();
  const writeText = jest.fn().mockResolvedValue(undefined);
  shipmentActivityApi.listShipmentActivity.mockResolvedValueOnce(shipmentPage).mockReturnValueOnce(queue.promise);
  dryRunApi.getDryRunPodCurl.mockReturnValueOnce(envelope.promise);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<DirectActionHarness />);
  await waitFor(() => expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Direct queue refresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Direct select' }));
  expect(await screen.findByText('Journey ready')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Direct copy' }));
  expect(dryRunApi.getDryRunPodCurl).toHaveBeenCalledTimes(1);

  await act(async () => {
    queue.reject(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
    envelope.resolve(ENVELOPE);
    await Promise.resolve();
  });

  expect(screen.getByTestId('direct-terminal')).toHaveTextContent('unauthorized');
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.getByTestId('direct-action-feedback')).toBeEmptyDOMElement();
});

test('rechecks evidence identity after the awaited Clipboard write', async () => {
  const clipboard = deferred(); const refreshedJourney = deferred();
  const writeText = jest.fn(() => clipboard.promise);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  dryRunApi.getDryRunJourney.mockResolvedValueOnce(cloneJourney()).mockReturnValueOnce(refreshedJourney.promise);
  renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Copy pod cURL' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(EXPECTED_CURL));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));
  refreshedJourney.resolve(cloneJourney(value => { value.steps.payloadPreparation.requestHash = 'e'.repeat(64); }));
  clipboard.resolve(undefined);
  await act(async () => Promise.resolve());
  expect(screen.queryByText('Pod cURL copied')).not.toBeInTheDocument();
});

test('downloads authenticated exact Blob bytes with the exact filename and tracked delayed revocation', async () => {
  const blob = new Blob(['exact authenticated bytes'], { type: 'application/json' });
  dryRunApi.getDryRunRequestBlob.mockResolvedValue(blob);
  const createObjectURL = jest.fn(() => 'blob:oms-request'); const revokeObjectURL = jest.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  let clickedDownload = null;
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() { clickedDownload = this.download; });
  renderWorkspace(); await openDetail(); jest.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  expect(screen.getByRole('button', { name: 'Copy pod cURL' })).toBeDisabled();
  await act(async () => Promise.resolve());
  expect(dryRunApi.getDryRunRequestBlob).toHaveBeenCalledWith({ companyId: '12', jobId: 100 });
  expect(createObjectURL).toHaveBeenCalledWith(blob);
  expect(clickedDownload).toBe('INV-100-oeis-request.json');
  expect(revokeObjectURL).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(1);
  await act(async () => jest.runOnlyPendingTimers());
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:oms-request');
  expect(jest.getTimerCount()).toBe(0);
  click.mockRestore();
});

test('clears the registered revocation timer and revokes an outstanding object URL on unmount', async () => {
  const revokeObjectURL = jest.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:outstanding') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const view = renderWorkspace(); await openDetail(); jest.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  await act(async () => Promise.resolve());
  expect(jest.getTimerCount()).toBe(1);
  view.unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:outstanding');
  expect(jest.getTimerCount()).toBe(0);
  await act(async () => jest.runOnlyPendingTimers());
  expect(revokeObjectURL).toHaveBeenCalledTimes(1);
});

test('revokes outstanding URLs and clears their timers when another current request terminates the session', async () => {
  const revokeObjectURL = jest.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:terminal') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const view = renderWorkspace(); await openDetail(); jest.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  await act(async () => Promise.resolve());
  expect(jest.getTimerCount()).toBe(1);
  dryRunApi.getDryRunJourney.mockRejectedValueOnce(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }));
  await act(async () => Promise.resolve());
  expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:terminal');
  expect(jest.getTimerCount()).toBe(0);
  view.unmount();
});

test('ignores stale download completion after selection change and unmount', async () => {
  const first = deferred(); const second = deferred();
  dryRunApi.getDryRunRequestBlob.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const createObjectURL = jest.fn(() => 'blob:stale');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  const view = renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to Shipments' }));
  first.resolve(new Blob(['stale'])); await act(async () => Promise.resolve());
  expect(createObjectURL).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /shipment-100.*success/i }));
  await screen.findByRole('heading', { name: 'Evidence' });
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  view.unmount(); second.resolve(new Blob(['unmounted'])); await act(async () => Promise.resolve());
  expect(createObjectURL).not.toHaveBeenCalled();
});

test('revokes immediately when link click fails and reports only fixed download feedback', async () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:failed') });
  const revokeObjectURL = jest.fn(); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error(`PRIVATE ${ENVELOPE.apiKey}`); });
  renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  expect(await screen.findByText('Diagnostic JSON could not be downloaded')).toBeInTheDocument();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed');
  expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();
});

test('makes a current download 401 terminal but ignores an old-route download 401', async () => {
  const pending = deferred();
  dryRunApi.getDryRunRequestBlob.mockReturnValueOnce(pending.promise);
  renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change route' }));
  pending.reject(Object.assign(new Error('private'), { kind: 'unauthorized' }));
  await act(async () => Promise.resolve());
  expect(screen.queryByText('Session expired')).not.toBeInTheDocument();

  dryRunApi.getDryRunRequestBlob.mockRejectedValueOnce(Object.assign(new Error('private'), { kind: 'unauthorized' }));
  await openDetail(); fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
});

test('fetches a fresh envelope on every click and copies the exact POSIX-safe command without exposing secrets', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { container } = renderWorkspace(); await openDetail();
  const button = screen.getByRole('button', { name: 'Copy pod cURL' });
  fireEvent.click(button);
  await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(1, EXPECTED_CURL));
  fireEvent.click(button);
  await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(2, EXPECTED_CURL));
  expect(dryRunApi.getDryRunPodCurl).toHaveBeenNthCalledWith(1, { companyId: '12', jobId: 100 });
  expect(dryRunApi.getDryRunPodCurl).toHaveBeenNthCalledWith(2, { companyId: '12', jobId: 100 });
  expect(screen.getByText('Pod cURL copied')).toBeInTheDocument();
  expect(container).not.toHaveTextContent(ENVELOPE.url);
  expect(container).not.toHaveTextContent(ENVELOPE.apiKey);
  expect(container).not.toHaveTextContent(ENVELOPE.requestJson);
  expect(container.innerHTML).not.toContain(ENVELOPE.url);
  expect(container.innerHTML).not.toContain(ENVELOPE.apiKey);
  expect(container.innerHTML).not.toContain(ENVELOPE.requestJson);
  expect(document.querySelector('textarea')).toBeNull();
});

test('suppresses duplicate copy clicks and uses Clipboard only with fixed rejection feedback', async () => {
  const pending = deferred(); const execCommand = jest.fn();
  dryRunApi.getDryRunPodCurl.mockReturnValueOnce(pending.promise);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  renderWorkspace(); await openDetail();
  const button = screen.getByRole('button', { name: 'Copy pod cURL' });
  fireEvent.click(button); fireEvent.click(button);
  expect(dryRunApi.getDryRunPodCurl).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled(); expect(button).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Download diagnostic JSON' })).toBeDisabled();
  pending.resolve(ENVELOPE);
  expect(await screen.findByText('Pod cURL could not be copied')).toBeInTheDocument();
  expect(execCommand).not.toHaveBeenCalled();
  expect(document.querySelector('textarea')).toBeNull();
});

test('does not use a DOM fallback or expose a Clipboard rejection', async () => {
  const writeText = jest.fn().mockRejectedValue(new Error(`PRIVATE ${ENVELOPE.url} ${ENVELOPE.apiKey}`));
  const execCommand = jest.fn();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  const { container } = renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Copy pod cURL' }));
  expect(await screen.findByText('Pod cURL could not be copied')).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith(EXPECTED_CURL);
  expect(execCommand).not.toHaveBeenCalled();
  expect(document.querySelector('textarea')).toBeNull();
  expect(container.innerHTML).not.toContain('PRIVATE');
  expect(container.innerHTML).not.toContain(ENVELOPE.url);
  expect(container.innerHTML).not.toContain(ENVELOPE.apiKey);
});

test('ignores stale copy success/401 after selection, route, or unmount and never calls Clipboard', async () => {
  const pending = deferred(); const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  dryRunApi.getDryRunPodCurl.mockReturnValue(pending.promise);
  const view = renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Copy pod cURL' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change route' }));
  pending.resolve(ENVELOPE); await act(async () => Promise.resolve());
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.queryByText('Pod cURL copied')).not.toBeInTheDocument();
  view.unmount();
});

test('ignores a pending copy after Back changes the selection or after unmount', async () => {
  const selectionPending = deferred(); const unmountPending = deferred();
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  dryRunApi.getDryRunPodCurl.mockReturnValueOnce(selectionPending.promise).mockReturnValueOnce(unmountPending.promise);
  const view = renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Copy pod cURL' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to Shipments' }));
  selectionPending.resolve(ENVELOPE); await act(async () => Promise.resolve());
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /shipment-100.*success/i }));
  await screen.findByRole('button', { name: 'Copy pod cURL' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy pod cURL' }));
  view.unmount(); unmountPending.resolve(ENVELOPE); await act(async () => Promise.resolve());
  expect(writeText).not.toHaveBeenCalled();
});

test('maps current copy 404 to journey unavailable and current 401 to terminal state', async () => {
  dryRunApi.getDryRunPodCurl.mockRejectedValueOnce(Object.assign(new Error('private'), { kind: 'not-found' }));
  renderWorkspace(); await openDetail();
  fireEvent.click(screen.getByRole('button', { name: 'Copy pod cURL' }));
  expect(await screen.findByText('Journey evidence unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy pod cURL' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Back to Shipments' }));
  dryRunApi.getDryRunJourney.mockResolvedValueOnce(cloneJourney());
  dryRunApi.getDryRunPodCurl.mockRejectedValueOnce(Object.assign(new Error('private'), { kind: 'unauthorized' }));
  fireEvent.click(screen.getByRole('button', { name: /shipment-100.*success/i }));
  await screen.findByRole('button', { name: 'Copy pod cURL' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy pod cURL' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
});
