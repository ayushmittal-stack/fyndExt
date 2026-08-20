import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import App from '../App';

jest.mock('../pages/Home', () => ({
  Home: () => <div>Classic Home</div>,
}));

afterEach(() => {
  window.localStorage.clear();
});

test('renders the selected route-scoped extension experience', () => {
  window.localStorage.setItem('sgh-einvoice:ui-mode:v1:12:34', 'oms');

  render(
    <MemoryRouter
      initialEntries={['/company/12/application/34']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route path="/company/:company_id/application/:application_id" element={<App />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
});
