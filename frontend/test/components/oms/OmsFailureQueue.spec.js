import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { OmsWorkspace } from '../../../components/oms/OmsWorkspace';
import { dryRunJourney, jobFailurePage, preJobFailurePage, shipmentPage, timelinePage } from './omsFixtures';
import * as dryRunApi from '../../../services/dryRunApi';
import * as shipmentActivityApi from '../../../services/shipmentActivityApi';

jest.mock('../../../services/dryRunApi', () => ({ getDryRunJourney: jest.fn(), getDryRunPodCurl: jest.fn(), getDryRunRequestBlob: jest.fn(), listDryRunFailures: jest.fn(), listDryRuns: jest.fn() }));
jest.mock('../../../services/shipmentActivityApi', () => ({ getShipmentTimeline: jest.fn(), listPreJobFailures: jest.fn(), listShipmentActivity: jest.fn() }));

function deferred() { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function renderWorkspace() { return render(<MemoryRouter initialEntries={['/company/12/application/34']}><Routes><Route path="/company/:company_id/application/:application_id" element={<OmsWorkspace />} /></Routes></MemoryRouter>); }
function activateFailures() { fireEvent.click(screen.getByRole('tab', { name: /Failures/ })); }
beforeEach(() => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  dryRunApi.listDryRunFailures.mockResolvedValue(jobFailurePage);
  shipmentActivityApi.listPreJobFailures.mockResolvedValue(preJobFailurePage);
  shipmentActivityApi.getShipmentTimeline.mockImplementation(({ shipmentId }) => Promise.resolve({
    ...timelinePage,
    shipmentId,
    items: timelinePage.items.map(item => ({ ...item, shipmentId })),
  }));
  dryRunApi.getDryRunJourney.mockResolvedValue({
    ...dryRunJourney,
    job: { ...dryRunJourney.job, jobId: 70 },
  });
});
afterEach(() => { jest.resetAllMocks(); });

test('starts both bounded failure groups in parallel only on activation', async () => {
  const jobs = deferred(); const preJobs = deferred();
  dryRunApi.listDryRunFailures.mockReturnValueOnce(jobs.promise);
  shipmentActivityApi.listPreJobFailures.mockReturnValueOnce(preJobs.promise);
  renderWorkspace();
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  expect(dryRunApi.listDryRunFailures).not.toHaveBeenCalled();
  expect(shipmentActivityApi.listPreJobFailures).not.toHaveBeenCalled();
  activateFailures();
  expect(dryRunApi.listDryRunFailures).toHaveBeenCalledWith({ companyId: '12', limit: 20, beforeId: null });
  expect(shipmentActivityApi.listPreJobFailures).toHaveBeenCalledWith({ companyId: '12', limit: 20, before: null });
  expect(dryRunApi.listDryRunFailures).toHaveBeenCalledTimes(1);
  expect(shipmentActivityApi.listPreJobFailures).toHaveBeenCalledTimes(1);
  expect(dryRunApi.listDryRuns).not.toHaveBeenCalled();
  jobs.resolve(jobFailurePage); preJobs.resolve(preJobFailurePage);
  expect(await screen.findByText('Invoice data failed local validation.')).toBeInTheDocument();
  const lastRefreshed = screen.getByText(/Last refreshed/);
  expect(lastRefreshed).toHaveAttribute('role', 'status');
  expect(lastRefreshed).toHaveAttribute('aria-live', 'polite');
  expect(lastRefreshed).toHaveAttribute('aria-atomic', 'true');
});

test('renders separate groups, safe failure evidence, counts, and suppresses pre-job duplicates', async () => {
  const { container } = renderWorkspace(); activateFailures();
  const region = await screen.findByRole('region', { name: 'Failure queues' });
  expect(within(region).getByRole('heading', { name: 'Job failures' })).toBeInTheDocument();
  expect(within(region).getByRole('heading', { name: 'Rejected before a job was created' })).toBeInTheDocument();
  expect(within(region).getByText('Invoice data failed local validation.')).toBeInTheDocument();
  expect(within(region).getByText('Attempt 2')).toBeInTheDocument();
  expect(within(region).getByText('LOCAL_VALIDATION_FAILED')).toBeInTheDocument();
  expect(within(region).getByText('CURRENCY_UNSUPPORTED')).toBeInTheDocument();
  expect(within(region).queryByText('DUPLICATE_SENTINEL')).not.toBeInTheDocument();
  expect(within(region).getByText('1 loaded job failure')).toBeInTheDocument();
  expect(within(region).getByText('1 loaded pre-job rejection')).toBeInTheDocument();
  expect(container).not.toHaveTextContent('globally sorted');
  ['Retry', 'Reprocess', 'Unlock', 'Approve', 'Submit', 'Import', 'Reconcile'].forEach(name => expect(screen.queryByRole('button', { name: new RegExp(name, 'i') })).not.toBeInTheDocument());
});

test('opens job and pre-job failures in the shared detail and returns to the cached Failures queue', async () => {
  renderWorkspace(); activateFailures();
  fireEvent.click(await screen.findByRole('button', { name: /Shipment failed-70/i }));
  expect(await screen.findByRole('heading', { name: 'failed-70', level: 1 })).toBeInTheDocument();
  expect(shipmentActivityApi.getShipmentTimeline).toHaveBeenLastCalledWith({ companyId: '12', shipmentId: 'failed-70', limit: 50, before: null });
  expect(dryRunApi.getDryRunJourney).toHaveBeenLastCalledWith({ companyId: '12', jobId: 70 });
  fireEvent.click(screen.getByRole('button', { name: 'Back to Failures' }));
  expect(screen.getByRole('button', { name: /Shipment failed-70/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Shipment prejob-60/i }));
  expect(await screen.findByRole('heading', { name: 'prejob-60', level: 1 })).toBeInTheDocument();
  expect(shipmentActivityApi.getShipmentTimeline).toHaveBeenLastCalledWith({ companyId: '12', shipmentId: 'prejob-60', limit: 50, before: null });
  expect(dryRunApi.getDryRunJourney).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Back to Failures' }));
  expect(dryRunApi.listDryRunFailures).toHaveBeenCalledTimes(1);
  expect(shipmentActivityApi.listPreJobFailures).toHaveBeenCalledTimes(1);
});

test('paginates each group independently and retries its unchanged cursor after failure', async () => {
  const olderJob = { ...jobFailurePage.items[0], jobId: 69, shipmentId: 'failed-69', documentNumber: 'INV-69' };
  const olderPreJob = { ...preJobFailurePage.items[1], shipmentId: 'prejob-59', lastSafeCode: 'ADDRESS_INVALID' };
  dryRunApi.listDryRunFailures.mockResolvedValueOnce(jobFailurePage).mockRejectedValueOnce(new Error('private')).mockResolvedValueOnce({ items: [olderJob], nextBeforeId: null });
  shipmentActivityApi.listPreJobFailures.mockResolvedValueOnce(preJobFailurePage).mockResolvedValueOnce({ items: [olderPreJob], nextBefore: null });
  renderWorkspace(); activateFailures();
  await screen.findByText('Invoice data failed local validation.');
  fireEvent.click(screen.getByRole('button', { name: 'Load more job failures' }));
  expect(await screen.findByText('Could not load more job failures')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more job failures' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load more pre-job rejections' }));
  expect(await screen.findByText('ADDRESS_INVALID')).toBeInTheDocument();
  expect(await screen.findByText('INV-69')).toBeInTheDocument();
  expect(dryRunApi.listDryRunFailures.mock.calls.slice(1).map(([value]) => value.beforeId)).toEqual([70, 70]);
  expect(shipmentActivityApi.listPreJobFailures).toHaveBeenLastCalledWith({ companyId: '12', limit: 20, before: 'prejob-cursor-60' });
});

test('deduplicates overlapping pages independently within both failure subgroups', async () => {
  const olderJob = { ...jobFailurePage.items[0], jobId: 69, shipmentId: 'failed-69', documentNumber: 'INV-69' };
  const olderPreJob = { ...preJobFailurePage.items[1], shipmentId: 'prejob-59', lastSafeCode: 'ADDRESS_INVALID' };
  dryRunApi.listDryRunFailures.mockResolvedValueOnce(jobFailurePage).mockResolvedValueOnce({ items: [jobFailurePage.items[0], olderJob, { ...olderJob }], nextBeforeId: null });
  shipmentActivityApi.listPreJobFailures.mockResolvedValueOnce(preJobFailurePage).mockResolvedValueOnce({ items: [preJobFailurePage.items[1], olderPreJob, { ...olderPreJob }], nextBefore: null });
  renderWorkspace(); activateFailures();
  await screen.findByText('Invoice data failed local validation.');
  fireEvent.click(screen.getByRole('button', { name: 'Load more job failures' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load more pre-job rejections' }));
  expect(await screen.findAllByText('INV-69')).toHaveLength(1);
  expect(await screen.findAllByText('ADDRESS_INVALID')).toHaveLength(1);
  expect(screen.getAllByText('INV-70')).toHaveLength(1);
  expect(screen.getAllByText('CURRENCY_UNSUPPORTED')).toHaveLength(1);
});

test('retains independently verified groups through partial initial and Refresh failures', async () => {
  dryRunApi.listDryRunFailures
    .mockRejectedValueOnce(new Error('private'))
    .mockResolvedValueOnce(jobFailurePage)
    .mockRejectedValueOnce(new Error('private'));
  shipmentActivityApi.listPreJobFailures
    .mockResolvedValueOnce(preJobFailurePage)
    .mockRejectedValueOnce(new Error('private'))
    .mockResolvedValueOnce(preJobFailurePage);
  renderWorkspace(); activateFailures();
  expect(await screen.findByText('CURRENCY_UNSUPPORTED')).toBeInTheDocument();
  expect(screen.getByText('Could not load job failures')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(dryRunApi.listDryRunFailures).toHaveBeenLastCalledWith({ companyId: '12', limit: 20, beforeId: null });
  expect(shipmentActivityApi.listPreJobFailures).toHaveBeenLastCalledWith({ companyId: '12', limit: 20, before: null });
  expect(await screen.findByText('Invoice data failed local validation.')).toBeInTheDocument();
  expect(screen.getByText('Pre-job rejection refresh failed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('Job failure refresh failed')).toBeInTheDocument();
  expect(screen.getByText('Invoice data failed local validation.')).toBeInTheDocument();
  expect(screen.getByText('CURRENCY_UNSUPPORTED')).toBeInTheDocument();
});

test('subgroup ABA ignores stale success and 401 after returning to Failures', async () => {
  const staleJob = deferred(); const stalePreJob = deferred();
  dryRunApi.listDryRunFailures.mockReturnValueOnce(staleJob.promise).mockResolvedValueOnce(jobFailurePage);
  shipmentActivityApi.listPreJobFailures.mockReturnValueOnce(stalePreJob.promise).mockResolvedValueOnce(preJobFailurePage);
  renderWorkspace(); activateFailures();
  await act(async () => Promise.resolve());
  fireEvent.click(screen.getByRole('tab', { name: /Shipments/ }));
  activateFailures();
  expect(await screen.findByText('Invoice data failed local validation.')).toBeInTheDocument();
  staleJob.resolve({ items: [{ ...jobFailurePage.items[0], jobId: 999, shipmentId: 'stale-job', documentNumber: 'STALE-JOB' }], nextBeforeId: null });
  stalePreJob.reject(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
  await act(async () => Promise.resolve());
  expect(screen.queryByText('STALE-JOB')).not.toBeInTheDocument();
  expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
  expect(screen.getByText('Invoice data failed local validation.')).toBeInTheDocument();
});

test('refetches an interrupted unverified Failures activation while stale completions are ignored', async () => {
  const pendingJobs = deferred(); const pendingPreJobs = deferred();
  dryRunApi.listDryRunFailures.mockReturnValueOnce(pendingJobs.promise);
  shipmentActivityApi.listPreJobFailures.mockReturnValueOnce(pendingPreJobs.promise);
  renderWorkspace(); activateFailures();
  fireEvent.click(screen.getByRole('tab', { name: /Shipments/ }));
  pendingJobs.reject(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
  pendingPreJobs.resolve(preJobFailurePage);
  await act(async () => Promise.resolve());
  expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
  activateFailures();
  expect(dryRunApi.listDryRunFailures).toHaveBeenCalledTimes(2);
  expect(shipmentActivityApi.listPreJobFailures).toHaveBeenCalledTimes(2);
});

test('returns to a fully loaded Failures cache without refetching either subgroup', async () => {
  renderWorkspace(); activateFailures();
  await screen.findByText('Invoice data failed local validation.');
  fireEvent.click(screen.getByRole('tab', { name: /Shipments/ }));
  activateFailures();
  expect(screen.getByText('Invoice data failed local validation.')).toBeInTheDocument();
  expect(dryRunApi.listDryRunFailures).toHaveBeenCalledTimes(1);
  expect(shipmentActivityApi.listPreJobFailures).toHaveBeenCalledTimes(1);
});

test.each(['job', 'preJob'])('a current 401 from the active %s subgroup is terminal', async group => {
  const error = Object.assign(new Error('expired'), { kind: 'unauthorized' });
  if (group === 'job') dryRunApi.listDryRunFailures.mockRejectedValueOnce(error);
  else shipmentActivityApi.listPreJobFailures.mockRejectedValueOnce(error);
  renderWorkspace(); activateFailures();
  expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
});
