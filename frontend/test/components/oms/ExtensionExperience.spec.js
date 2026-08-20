import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
} from 'react-router-dom';

import { ExtensionExperience } from '../../../components/oms/ExtensionExperience';
import * as dryRunApi from '../../../services/dryRunApi';
import * as shipmentActivityApi from '../../../services/shipmentActivityApi';

jest.mock('../../../pages/Home', () => {
  const ReactModule = require('react');
  return {
    Home: () => {
      ReactModule.useEffect(() => {
        const timer = setInterval(() => {}, 5000);
        return () => clearInterval(timer);
      }, []);
      return ReactModule.createElement('div', { 'data-testid': 'classic-home' }, 'Classic Home');
    },
  };
});

jest.mock('../../../services/dryRunApi', () => ({
  getDryRunJourney: jest.fn(), getDryRunPodCurl: jest.fn(), getDryRunRequestBlob: jest.fn(),
  listDryRunFailures: jest.fn(), listDryRuns: jest.fn(),
}));

jest.mock('../../../services/shipmentActivityApi', () => ({
  getShipmentTimeline: jest.fn(), listPreJobFailures: jest.fn(), listShipmentActivity: jest.fn(),
}));

function deferred() {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const shipmentPage = {
  items: [{
    shipmentId: 'current-oms-shipment', jobId: 501, documentNumber: 'INV-OMS-1',
    lastStage: 'JOB', lastAction: 'JOB_COMPLETED', lastOutcome: 'SUCCESS', lastSafeCode: null,
    firstOccurredAt: '2026-08-19T09:00:00.000Z', lastOccurredAt: '2026-08-19T10:00:00.000Z', version: 1,
  }],
  nextBefore: null,
};

function renderExperience(initialEntry = '/company/12/application/34') {
  return render(
    <MemoryRouter
      initialEntries={[initialEntry]}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route
          path="/company/:company_id/application/:application_id"
          element={<ExtensionExperience />}
        />
        <Route path="/company/:company_id/" element={<ExtensionExperience />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderNavigableExperience() {
  return render(
    <MemoryRouter
      initialEntries={['/company/12/application/34']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Link to="/company/12/application/35">Change application</Link>
      <Routes>
        <Route
          path="/company/:company_id/application/:application_id"
          element={<ExtensionExperience />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
  jest.resetAllMocks();
  jest.useRealTimers();
});

test('defaults to Classic and mounts only Home', () => {
  renderExperience();

  expect(screen.getByTestId('classic-home')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'E-Invoicing Shipments' })).not.toBeInTheDocument();
});

test('switches to OMS and unmounts the Classic timer', () => {
  jest.useFakeTimers();
  renderExperience();
  expect(jest.getTimerCount()).toBe(1);

  fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));

  expect(screen.queryByTestId('classic-home')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
  expect(jest.getTimerCount()).toBe(0);
});

test('restores OMS only for the matching company and application', () => {
  window.localStorage.setItem('sgh-einvoice:ui-mode:v1:12:34', 'oms');

  renderExperience();

  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
  expect(screen.queryByTestId('classic-home')).not.toBeInTheDocument();
});

test.each([
  '/company/12/application/35',
  '/company/13/application/34',
])('does not reuse another route preference for %s', initialEntry => {
  window.localStorage.setItem('sgh-einvoice:ui-mode:v1:12:34', 'oms');

  renderExperience(initialEntry);

  expect(screen.getByTestId('classic-home')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'E-Invoicing Shipments' })).not.toBeInTheDocument();
});

test('uses a separate company-level preference', () => {
  window.localStorage.setItem('sgh-einvoice:ui-mode:v1:12:company', 'oms');

  renderExperience('/company/12/');

  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
});

test('reloads the preference when the application route changes', () => {
  window.localStorage.setItem('sgh-einvoice:ui-mode:v1:12:34', 'oms');
  renderNavigableExperience();
  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('link', { name: 'Change application' }));

  expect(screen.getByTestId('classic-home')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'E-Invoicing Shipments' })).not.toBeInTheDocument();
});

test('falls back to Classic for an invalid stored value', () => {
  window.localStorage.setItem('sgh-einvoice:ui-mode:v1:12:34', 'future');

  renderExperience();

  expect(screen.getByTestId('classic-home')).toBeInTheDocument();
});

test('falls back to Classic when the stored preference cannot be read', () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('storage unavailable');
  });

  renderExperience();

  expect(screen.getByTestId('classic-home')).toBeInTheDocument();
});

test('continues in memory when localStorage.setItem throws', () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage unavailable');
  });
  renderExperience();

  fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));

  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
  expect(screen.queryByTestId('classic-home')).not.toBeInTheDocument();
});

test('switching away unmounts OMS work, ignores its stale response, and starts a fresh bounded mount', async () => {
  const staleRequest = deferred();
  shipmentActivityApi.listShipmentActivity
    .mockReturnValueOnce(staleRequest.promise)
    .mockResolvedValueOnce(shipmentPage);
  renderExperience();

  fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledWith({ companyId: '12', limit: 20, before: null });
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: 'Classic' }));
  expect(screen.getByTestId('classic-home')).toBeInTheDocument();
  await act(async () => { staleRequest.resolve({ ...shipmentPage, items: [{ ...shipmentPage.items[0], shipmentId: 'stale-oms-shipment' }] }); });
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('stale-oms-shipment')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(2);
  expect(await screen.findByRole('button', { name: /current-oms-shipment.*success/i })).toBeInTheDocument();
  expect(screen.queryByTestId('classic-home')).not.toBeInTheDocument();
  expect(dryRunApi.listDryRuns).not.toHaveBeenCalled();
});

test('terminal OMS lockout remains disabled until a fresh mode mount', async () => {
  shipmentActivityApi.listShipmentActivity
    .mockRejectedValueOnce(Object.assign(new Error('expired'), { kind: 'unauthorized' }))
    .mockResolvedValueOnce(shipmentPage);
  renderExperience();

  fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: 'Classic' }));
  fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));
  expect(await screen.findByRole('button', { name: /current-oms-shipment.*success/i })).toBeInTheDocument();
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(2);
});
