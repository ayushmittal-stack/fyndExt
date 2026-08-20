import { readFileSync } from 'fs';
import { resolve } from 'path';

const css = readFileSync(resolve(__dirname, '../../../components/oms/oms.css'), 'utf8');

function rule(selector) {
  return css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] || '';
}

test('keeps New OMS typography readable independently of the host root scale', () => {
  const omsRoot = rule('\\.extension-experience-root\\.is-oms');
  const activityDrawer = rule('\\.oms-activity-drawer');

  expect(css).not.toMatch(/\d(?:\.\d+)?rem\b/);
  expect(omsRoot).toMatch(/font-size:\s*14px/);
  expect(activityDrawer).toMatch(/font-size:\s*14px/);
});

test('keeps evidence summaries readable and easy to activate', () => {
  const evidenceSummary = rule('\\.oms-evidence summary');

  expect(evidenceSummary).toMatch(/display:\s*flex/);
  expect(evidenceSummary).toMatch(/align-items:\s*center/);
  expect(evidenceSummary).toMatch(/min-height:\s*44px/);
  expect(evidenceSummary).toMatch(/font-size:\s*14px/);
});

test('keeps failure-row buttons visually integrated and keyboard-visible', () => {
  const failureRow = rule('\\.oms-failure-row');

  expect(failureRow).toMatch(/appearance:\s*none/);
  expect(failureRow).toMatch(/background:\s*#fff/);
  expect(failureRow).toMatch(/color:\s*var\(--oms-ink\)/);
  expect(failureRow).toMatch(/cursor:\s*pointer/);
  expect(failureRow).toMatch(/font:\s*inherit/);
  expect(failureRow).toMatch(/text-align:\s*left/);
  expect(failureRow).toMatch(/width:\s*100%/);
  expect(css).toMatch(/\.oms-failure-row:hover\s*\{[^}]*background:\s*#fbf9fd/s);
  expect(css).toMatch(/\.oms-failure-row:focus-visible[^}]*outline:\s*3px solid var\(--oms-accent\)/s);
  expect(css).not.toMatch(/:focus-visible[^{}]*\{[^}]*outline:\s*3px solid rgba\(91, 42, 134, \.35\)/s);
  expect(rule('\\.oms-failure-row > div')).toMatch(/min-width:\s*0/);
  expect(rule('\\.oms-failure-row p')).toMatch(/overflow-wrap:\s*anywhere/);
});

test('stacks shipment rows before their desktop tracks can clip tablet widths', () => {
  expect(css).toMatch(/@media\s*\(max-width:\s*960px\)\s*\{[\s\S]*?\.oms-shipment-row\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s);
  expect(css).toMatch(/@media\s*\(max-width:\s*800px\)\s*\{[\s\S]*?\.oms-filters\s*\{[^}]*grid-template-columns:\s*1fr/s);
});
