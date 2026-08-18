import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { ShipmentActivityLog } from '../components/activity/ShipmentActivityLog';
import { DryRunJourney } from '../components/dry-run/DryRunJourney';

const REFRESH_SUCCESS = 'All extension data refreshed.';
const REFRESH_PARTIAL = 'Some extension data could not be refreshed. Existing data is still shown.';

function settledStatus(result) {
  if (result.status === 'rejected') return 'partial';
  return result.value?.status || 'partial';
}

export const Home = () => {
  const { application_id, company_id } = useParams();
  const routeKey = JSON.stringify([
    String(company_id),
    application_id === undefined ? null : String(application_id),
  ]);
  const [refreshView, setRefreshView] = useState({
    routeKey,
    busy: false,
    terminal: false,
    message: '',
  });
  const mountedRef = useRef(false);
  const currentRouteRef = useRef(routeKey);
  const refreshGenerationRef = useRef(0);
  const activeRefreshRef = useRef(null);
  const terminalRouteRef = useRef(null);
  const dryRunRef = useRef(null);
  const activityRef = useRef(null);

  if (currentRouteRef.current !== routeKey) {
    currentRouteRef.current = routeKey;
    activeRefreshRef.current = null;
  }

  const terminateRoute = useCallback(affectedRouteKey => {
    if (!mountedRef.current || currentRouteRef.current !== affectedRouteKey) return;
    if (terminalRouteRef.current === affectedRouteKey) return;
    terminalRouteRef.current = affectedRouteKey;
    activeRefreshRef.current = null;
    setRefreshView({
      routeKey: affectedRouteKey,
      busy: false,
      terminal: true,
      message: '',
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRefreshRef.current = null;
    };
  }, []);

  useEffect(() => {
    terminalRouteRef.current = null;
    setRefreshView({ routeKey, busy: false, terminal: false, message: '' });
  }, [routeKey]);

  const refreshAll = useCallback(() => {
    const requestRouteKey = routeKey;
    if (terminalRouteRef.current === requestRouteKey) return;
    if (activeRefreshRef.current?.routeKey === requestRouteKey) return;

    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const token = { routeKey: requestRouteKey, generation };
    activeRefreshRef.current = token;
    setRefreshView({
      routeKey: requestRouteKey,
      busy: true,
      terminal: false,
      message: '',
    });

    const dryRunPromise = dryRunRef.current?.refreshAll?.(generation)
      || Promise.resolve({ status: 'partial', generation });
    const activityPromise = activityRef.current?.refreshAll?.(generation)
      || Promise.resolve({ status: 'partial', generation });

    Promise.allSettled([dryRunPromise, activityPromise]).then(results => {
      if (!mountedRef.current || currentRouteRef.current !== requestRouteKey
          || activeRefreshRef.current !== token) return;
      activeRefreshRef.current = null;
      const statuses = results.map(settledStatus);
      const unauthorized = statuses.includes('unauthorized')
        || terminalRouteRef.current === requestRouteKey;
      if (unauthorized) {
        terminalRouteRef.current = requestRouteKey;
        setRefreshView({
          routeKey: requestRouteKey,
          busy: false,
          terminal: true,
          message: '',
        });
        return;
      }
      const allSuccessful = statuses.every(status => status === 'success');
      setRefreshView({
        routeKey: requestRouteKey,
        busy: false,
        terminal: false,
        message: allSuccessful ? REFRESH_SUCCESS : REFRESH_PARTIAL,
      });
    });
  }, [routeKey]);

  const shownRefresh = refreshView.routeKey === routeKey
    ? refreshView
    : { busy: false, terminal: false, message: '' };

  return (
    <>
      <DryRunJourney
        key={`dry-run:${routeKey}`}
        ref={dryRunRef}
        companyId={company_id}
        routeKey={routeKey}
        onRefreshAll={refreshAll}
        extensionRefreshing={shownRefresh.busy}
        extensionRefreshDisabled={shownRefresh.terminal}
        extensionRefreshMessage={shownRefresh.message}
        routeTerminal={shownRefresh.terminal}
        onSessionUnauthorized={terminateRoute}
      />
      <ShipmentActivityLog
        key={`shipment-activity:${routeKey}`}
        ref={activityRef}
        companyId={company_id}
        routeKey={routeKey}
        routeTerminal={shownRefresh.terminal}
        onSessionUnauthorized={terminateRoute}
      />
    </>
  );
};
