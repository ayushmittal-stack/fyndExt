# Conditional Healthcare VAT for OEIS Invoicing Design

## Status

Approved on 17 August 2026 with the Fynd raw-field mapping below. Live OEIS
submission remains gated on Thomson Reuters confirmation of the OEIS
prepayment-field semantics and approval of the required storage controls.

## Goal

Keep the 300 already accepted OEIS Product Master records under their existing
SKUs, and resolve each invoice line as either standard-rated healthcare or the
government-borne Saudi-citizen healthcare treatment when order evidence and
financials support that decision.

## Authoritative Contract Findings

The OEIS Product Master contract does not contain tax category, tax rate, tax
amount, or VAT reason fields. Product tax data belongs to the Transaction API.
Accordingly, no production Product Master re-upload is required for this tax
change.

For ZATCA e-invoice representation:

- eligible private healthcare supplied to a Saudi citizen under the
  government-borne VAT mechanism uses category `Z`, rate `0.00`, and
  `VATEX-SA-HEA`;
- private healthcare outside that mechanism uses category `S` and rate
  `15.00`, without a VAT reason code;
- qualifying medicines or medical equipment use category `Z`, rate `0.00`,
  and `VATEX-SA-35` only when separately identified and supported by an
  authoritative qualification;
- `VATEX-SA-29` is a financial-services exemption and must not be used for
  healthcare merely because an insurer is involved.

For a simplified invoice using `VATEX-SA-HEA`, the OEIS request must include
the buyer name, buyer National ID, and buyer ID scheme `NAT`.

## Product-Master Decision

The 300 accepted Product Master records remain unchanged in OEIS. Existing
upload response files and cumulative accepted-product registries are immutable
execution evidence and must not be overwritten.

A new runtime registry is derived offline from the accepted product codes. It
stores product classification, never the final tax result:

```json
{
  "branches": ["DAMSGH", "JEDSGH", "E014", "MD101"],
  "products": {
    "FMDIF-001": {
      "uqc": "OTH",
      "supply_class": "PRIVATE_HEALTHCARE_SERVICE",
      "allowed_zero_rate_reason": "VATEX-SA-HEA"
    }
  }
}
```

The fixed `tax_category=S` and `tax_rate=15.00` values currently present in
local registry artifacts are historic local assumptions, not fields accepted
by OEIS Product Master. Future generated runtime registries use the new schema;
historic upload artifacts remain untouched.

If a product is later proven to be a separately supplied qualifying medicine
or medical good, it requires an explicit product classification amendment and
qualification reference. It must not be inferred from a healthcare product
name. A real Product Master correction such as product type or HSN/SAC is a
separate, vendor-confirmed same-SKU update and does not itself select a tax
category.

The invoice runtime namespace must match the accepted Product Master namespace:
`COMPANY_CODE=Viva Radix`, `SOURCE_ERP=Fynd`, and country `SA`. The current local
development values `37293/HIS_1104` and the application default `Fynd.com` are
not interchangeable with that namespace. They must be corrected in controlled
runtime configuration before invoice activation validation; the implementation must not edit a
developer's local `.env` automatically.

## Upstream Fynd Tax-Decision Contract

The authoritative government-borne VAT decision is the exact own boolean at
`body.payload.shipment.order.meta.custom_cart_meta.custom_conditions.taxation_nationality`.
SGH/Fynd owns the semantics of that field; the extension validates and records
the decision but does not infer nationality or eligibility from identity or
other order data.

When that decision is `true`, the exact own strings `recipient_name` and
`national_id` are required from the same `custom_conditions` object, and the
National ID must contain exactly 10 ASCII digits. When the decision is `false`,
neither buyer identity value is copied into the normalized snapshot or OEIS
request.

The exact own `body.event.id` is the non-PII evidence reference. It records
provenance; it does not redefine the authoritative SGH/Fynd decision. The exact
own `body.payload.shipment.shipment_status.status_created_at` is the
verification instant for the exact own `bag_confirmed` status on that same
plain `shipment_status` object. The extension never falls back to
`shipment.status`, `created_ts`, or `updated_ts` for either value.

At the resolver's injected current time, the verification instant must not be
in the future and must be no more than 24 hours old. Exactly 24 hours old is
accepted; 24 hours plus one millisecond, ancient evidence, and future evidence
all produce the same safe non-retryable eligibility error before the Fynd lock.
Prepared jobs keep their exact stored request bytes on retry and do not
re-evaluate this freshness rule.

The normalized internal decision is:

```json
{
  "government_borne_vat_eligible": true,
  "eligibility_reason": "VATEX-SA-HEA",
  "eligibility_evidence_reference": "eligibility-123",
  "eligibility_verified_at": "2026-08-17T00:00:00.000Z",
  "buyer_name": "Test Buyer",
  "buyer_national_id": "1000000000"
}
```

Decision meanings:

- `true`: derive healthcare category `Z`, rate `0.00`, and reason
  `VATEX-SA-HEA`; require all evidence and identity fields and require Fynd line
  tax financials to be `0.00`;
- `false`: derive category `S`, rate `15.00`, copy no buyer identity, and omit
  healthcare VAT reason fields;
- missing, null, contradictory, stale, or unsupported: hold the invoice with a
  deterministic non-retryable tax-eligibility error. Never guess `Z` or silently
  default an unclassified healthcare order.

The fixed policy version is `2026-08-17`. There is no policy environment flag;
new policy behavior requires an explicit reviewed release.

The upstream checkout/order calculation and the OEIS invoice must agree. The
extension validates Fynd financials; it does not change a paid `S/15` order into
`Z/0` after payment.

## Tax Resolver Contract

Create a pure resolver with this interface:

```js
resolveLineTax({ product, eligibility, financialBreakup, policyVersion })
```

It returns one frozen object:

```js
{
  category: 'Z',
  rate: '0.00',
  reasonCode: 'VATEX-SA-HEA',
  reasonText: 'Private healthcare to citizen',
  policyVersion: '2026-08-17',
  evidenceReference: 'eligibility-123'
}
```

or:

```js
{
  category: 'S',
  rate: '15.00',
  reasonCode: null,
  reasonText: null,
  policyVersion: '2026-08-17',
  evidenceReference: 'eligibility-456'
}
```

The resolver supports only the two healthcare outcomes above in the first
release. `VATEX-SA-35`, exemptions, manual overrides, and insurer-specific
rules are out of scope until their own source evidence and acceptance tests are
approved.

## OEIS Transaction Mapping

For an eligible `Z/0` healthcare line, emit:

```json
{
  "TRAN_TAX_CODE_CATEGORY": "Z",
  "TRAN_TAX_RATE": "0.00",
  "TRAN_TAX_AMOUNT": "0.00",
  "TRAN_VAT_EXEMPT_REASON_CODE": "VATEX-SA-HEA",
  "TRAN_VAT_EXEMPT_REASON_TEXT": "Private healthcare to citizen",
  "CUST_NAME_WALKIN": "Test Buyer",
  "CUST_ADDITIONAL_ID_NO_WALKIN": "1000000000",
  "CUST_ADDL_ID_TYP_WALKIN": "NAT"
}
```

For an `S/15` line, emit `S`, `15.00`, and the reconciled tax amount, and omit
the VAT reason fields. Customer fields remain subject to the existing invoice
contract.

Mixed `S` and `Z` lines are permitted only if controlled OEIS validation proves that the current
invoice envelope and total fields are accepted. Category and reason are
resolved per line; invoice totals are the sum of frozen line results.

## Financial Reconciliation

For `Z/0`:

- `gst_tax_percentage` must be `0.00`;
- `gst_fee` must be `0.00`;
- line amount paid must equal line net amount within `0.01` SAR.

For `S/15`:

- `gst_tax_percentage` must be `15.00`;
- tax must reconcile to 15% within one halala;
- line amount paid must equal line net plus tax within `0.01` SAR.

The builder must not silently recompute or override Fynd amounts. A mismatch is
a held invoice, not an OEIS submission.

`INV_CUSTOMER_PAID_AMOUNT` and the OEIS `PREPAID_*` fields remain a separate
contract gate. The previous dummy request was HTTP 200 but business-invalid
because OEIS treated a positive customer-paid amount as prepayment. No further
production submission is allowed until Thomson Reuters confirms the intended
mapping and a controlled validation response has `IsValidated=true`.

## Persistence and Retry Semantics

The normalized eligibility decision, non-PII evidence reference, policy
version, and resolved line tax decision are frozen with a newly accepted job.
Retries reuse the exact stored OEIS request bytes and never re-evaluate policy.

Existing jobs and issued invoices are immutable. A policy release applies only
to new jobs accepted after its effective deployment. Corrections to issued
invoices use the appropriate credit/debit-note process and preserve the
original tax decision.

## Privacy and Operations

National ID is sensitive personal data:

- never log it;
- redact it from held-job summaries and the dry-run UI;
- do not include it in downloadable diagnostic JSON;
- restrict access to the stored exact OEIS request and rely on approved
  encryption at rest for the job database;
- retain it only for the approved legal/audit period.

If encrypted-at-rest storage and access controls cannot be demonstrated, the
HEA path remains disabled.

The authenticated `GET /api/einvoice/dry-runs/failures` endpoint is
summary-only. It returns tenant-scoped `DATA_FAILED` and `INDETERMINATE` job
metadata, a safe failure code, and a service-owned allowlisted message. It never
returns the stored failure message, snapshot, exact OEIS request, request hash,
artifact, or outbox data, and it exposes no detail, retry, unlock, download, or
action API.

The held-job OEIS download is a sanitized diagnostic request, not the exact
stored request and not an executable submission body. The backend validates the
stored request bytes and hash first, parses the top-level OEIS row array, replaces
every `CUST_NAME_WALKIN` and `CUST_ADDITIONAL_ID_NO_WALKIN` value with
`<redacted>`, and deterministically serializes separate diagnostic bytes. The
persisted request bytes and hash used by workflow and retries remain unchanged.

## Rollout Gates

1. Preserve the approved exact-own Fynd mapping and its fail-closed validation.
2. Obtain Thomson Reuters confirmation for `INV_CUSTOMER_PAID_AMOUNT` and
   `PREPAID_*` semantics.
3. Generate the new runtime classification registry offline; do not call OEIS
   Product Master.
4. Implement and test the resolver, snapshot, persistence, builder, privacy,
   and retry changes.
5. Run controlled validation for one explicit ineligible `S/15` case, one eligible `Z/0` case,
   and one mixed invoice if mixed lines are required.
6. Require `IsValidated=true`, a valid signed XML artifact, correct XML tax
   category/reason, and no National ID leakage in logs or UI.
7. Approve encrypted-at-rest storage and access controls, then enable only new
   production jobs; retain a fail-closed rollback to held invoices. No live OEIS
   call is permitted before both unresolved gates are closed.
