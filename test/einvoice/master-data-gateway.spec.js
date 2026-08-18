'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { loadMasterData } = require('../../src/einvoice/master-data-gateway');

const APPROVED_BRANCHES = ['DAMSGH', 'JEDSGH', 'E014', 'MD101'];
const TAX_NEUTRAL_PRODUCT = {
  uqc: 'OTH',
  supply_class: 'PRIVATE_HEALTHCARE_SERVICE',
  allowed_zero_rate_reason: 'VATEX-SA-HEA',
};
const CANONICAL_MASTER_PATH = path.join(__dirname, '../../data/oeis-masters.json');
const CANONICAL_MASTER = JSON.parse(fs.readFileSync(CANONICAL_MASTER_PATH, 'utf8'));
const PRODUCT_CODE_SET_SHA256 = '682ac1f847e41b2673ae57ac9d62847417be9369ec3d6d813d3c1c3060731adc';

let directory;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oeis-masters-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function makeProducts() {
  return Object.fromEntries(Object.entries(CANONICAL_MASTER.products).map(([code, product]) => [
    code,
    { ...product },
  ]));
}

function makeMaster({ branches = APPROVED_BRANCHES, products = makeProducts() } = {}) {
  return { branches: [...branches], products };
}

function writeMasterData(contents = makeMaster()) {
  const filePath = path.join(directory, 'masters.json');
  fs.writeFileSync(filePath, JSON.stringify(contents), 'utf8');
  return filePath;
}

function writeRawMasterData(contents) {
  const filePath = path.join(directory, 'masters.json');
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

test('returns a frozen tax-neutral product classification in invoice field names', () => {
  const masterData = loadMasterData({ filePath: writeMasterData(), fsImpl: fs });

  const product = masterData.getProduct('FMDIF-001');
  expect(product).toEqual({
    code: 'FMDIF-001',
    uqc: 'OTH',
    supplyClass: 'PRIVATE_HEALTHCARE_SERVICE',
    allowedZeroRateReason: 'VATEX-SA-HEA',
  });
  expect(Object.isFrozen(product)).toBe(true);
  expect(product).not.toHaveProperty('taxCategory');
  expect(product).not.toHaveProperty('taxRate');
  expect(masterData.getBranch('DAMSGH')).toEqual({ code: 'DAMSGH' });
});

test('accepts the canonical reviewed 300-product registry', () => {
  const masterData = loadMasterData({ filePath: CANONICAL_MASTER_PATH, fsImpl: fs });

  expect(masterData.getProduct('WALKIN16')).toEqual(expect.objectContaining({
    code: 'WALKIN16',
    supplyClass: 'PRIVATE_HEALTHCARE_SERVICE',
  }));
});

test('uses SHA-256 over the UTF-8 compact JSON array of lexically sorted product codes', () => {
  const sortedCodes = Object.keys(CANONICAL_MASTER.products).sort();
  const input = JSON.stringify(sortedCodes);

  expect(crypto.createHash('sha256').update(input, 'utf8').digest('hex'))
    .toBe(PRODUCT_CODE_SET_SHA256);
});

test('rejects a product not in the approved registry', () => {
  const masterData = loadMasterData({ filePath: writeMasterData(), fsImpl: fs });

  expect(() => masterData.getProduct('UNKNOWN-SKU')).toThrow(expect.objectContaining({ code: 'MASTER_PRODUCT_UNKNOWN' }));
});

test('rejects duplicate approved branch codes at startup', () => {
  expect(() => loadMasterData({ filePath: writeMasterData(makeMaster({
    branches: [...APPROVED_BRANCHES, 'DAMSGH'],
  })), fsImpl: fs })).toThrow(expect.objectContaining({ code: 'MASTER_DUPLICATE_BRANCH' }));
});

test.each([
  ['missing', APPROVED_BRANCHES.slice(0, -1)],
  ['extra', [...APPROVED_BRANCHES, 'OTHER']],
  ['whitespace-padded', ['DAMSGH', 'JEDSGH', 'E014', ' MD101']],
])('rejects registry branch-set variant: %s', (_description, branches) => {
  expect(() => loadMasterData({
    filePath: writeMasterData(makeMaster({ branches })),
    fsImpl: fs,
  })).toThrow(expect.objectContaining({ code: 'MASTER_BRANCH_INVALID' }));
});

test.each([
  ['one approved product removed', (products) => { delete products.WALKIN16; }],
  ['one unapproved product added', (products) => { products['UNAPPROVED-SKU'] = { ...TAX_NEUTRAL_PRODUCT }; }],
  ['one approved product replaced', (products) => {
    delete products.WALKIN16;
    products['UNAPPROVED-SKU'] = { ...TAX_NEUTRAL_PRODUCT };
  }],
  ['one approved product case-changed', (products) => {
    delete products.WALKIN16;
    products.walkin16 = { ...TAX_NEUTRAL_PRODUCT };
  }],
])('rejects a registry with %s', (_description, change) => {
  const products = makeProducts();
  change(products);
  expect(() => loadMasterData({
    filePath: writeMasterData(makeMaster({ products })),
    fsImpl: fs,
  })).toThrow(expect.objectContaining({ code: 'MASTER_PRODUCT_INVALID' }));
});

test('accepts the exact approved product set in a different object-key order', () => {
  const products = Object.fromEntries(Object.entries(makeProducts()).reverse());

  expect(loadMasterData({
    filePath: writeMasterData(makeMaster({ products })),
    fsImpl: fs,
  }).getProduct('FMDIF-001')).toEqual(expect.objectContaining({ code: 'FMDIF-001' }));
});

test.each([
  {},
  { uqc: 'OTH', supply_class: 'PRIVATE_HEALTHCARE_SERVICE' },
  { uqc: 'PCE', supply_class: 'PRIVATE_HEALTHCARE_SERVICE', allowed_zero_rate_reason: 'VATEX-SA-HEA' },
  { uqc: 'OTH', supply_class: 'MEDICINE', allowed_zero_rate_reason: 'VATEX-SA-HEA' },
  { uqc: 'OTH', supply_class: 'PRIVATE_HEALTHCARE_SERVICE', allowed_zero_rate_reason: 'VATEX-SA-35' },
  { uqc: 'OTH', tax_category: 'S', tax_rate: '15.00' },
  { uqc: 'OTH', supply_class: 'PRIVATE_HEALTHCARE_SERVICE', allowed_zero_rate_reason: 'VATEX-SA-HEA', tax_rate: '15.00' },
])('rejects product entries outside the tax-neutral classification schema: %j', (product) => {
  const products = makeProducts();
  products['FMDIF-001'] = product;
  expect(() => loadMasterData({
    filePath: writeMasterData(makeMaster({ products })),
    fsImpl: fs,
  })).toThrow(expect.objectContaining({ code: 'MASTER_PRODUCT_INVALID' }));
});

test('rejects unapproved properties in the deployment registry', () => {
  const products = makeProducts();
  products['FMDIF-001'].description = 'not allowed';
  expect(() => loadMasterData({
    filePath: writeMasterData(makeMaster({ products })),
    fsImpl: fs,
  })).toThrow(expect.objectContaining({ code: 'MASTER_PRODUCT_INVALID' }));
});

test('rejects duplicate product keys in raw object-shaped JSON', () => {
  const filePath = writeRawMasterData('{"branches":["BRANCH-01"],"products":{"SKU-01":{"uqc":"OTH","supply_class":"PRIVATE_HEALTHCARE_SERVICE","allowed_zero_rate_reason":"VATEX-SA-HEA"},"SKU-01":{"uqc":"OTH","supply_class":"PRIVATE_HEALTHCARE_SERVICE","allowed_zero_rate_reason":"VATEX-SA-HEA"}}}');

  expect(() => loadMasterData({ filePath, fsImpl: fs }))
    .toThrow(expect.objectContaining({ code: 'MASTER_DUPLICATE_PRODUCT' }));
});

test('rejects prototype-sensitive product codes rather than treating them as registry entries', () => {
  const rawMaster = JSON.stringify(makeMaster()).replace('"FMDIF-001":', '"__proto__":');
  const filePath = writeRawMasterData(rawMaster);

  expect(() => loadMasterData({ filePath, fsImpl: fs }))
    .toThrow(expect.objectContaining({ code: 'MASTER_PRODUCT_INVALID' }));
});
