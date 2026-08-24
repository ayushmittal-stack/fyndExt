# Fynd to OEIS Field Mapping

Status: current implemented mapping, verified 22 August 2026
Scope: `application/shipment/update/v1` events for `bag_confirmed` healthcare-service shipments

## Purpose

This document maps every field emitted in the OEIS request to its authoritative source or business rule. It is intended for business, integration, and audit review.

The mapping has two stages:

1. The Fynd webhook is validated and converted into a canonical shipment snapshot.
2. The canonical snapshot is combined with approved configuration, master data, and healthcare tax policy to produce one OEIS row per Fynd bag.

No field uses an unverified "first value wins" fallback. When the same fact is present at multiple supported Fynd paths, every present value must agree or the shipment is rejected.

## Source classification

| Classification | Meaning |
|---|---|
| Fynd | Read directly from the signed Fynd shipment webhook. |
| Config | Fixed deployment identity validated at startup. |
| Master data | Read from the approved branch/product registry. |
| Derived | Calculated deterministically from validated source values. |
| Policy | Selected by the approved Saudi healthcare VAT policy. |
| Static | Exact OEIS integration constant; not supplied by Fynd. |

## Complete OEIS row mapping

Each Fynd bag produces one OEIS row. Invoice-level totals and delivery fields are repeated on every row because that is the implemented OEIS request contract.

| OEIS field | Classification | Fynd source / rule | Transformation and validation |
|---|---|---|---|
| `COMPANY_CODE` | Config | `OEIS_COMPANY_CODE` | Must be exactly `Viva Radix`. |
| `SOURCE_ERP` | Config | `OEIS_SOURCE_ERP` | Must be exactly `Fynd`. |
| `SUPPLIER_COUNTRY_CODE_ENGLISH` | Config | `OEIS_SUPPLIER_COUNTRY_CODE` | Must be exactly `SA`. |
| `COMPANY_ROLE` | Static | No Fynd source | Always `S` (supplier). |
| `INVOICE_TYPE` | Static | No Fynd source | Always `Simplified Tax Invoice`. |
| `INVOICE_SUBTYPE` | Static | No Fynd source | Always `Regular Domestic Supply`. |
| `TEMPLATE_CODE` | Static | No Fynd source | Always `SIMPLIFIED IN`. |
| `TRAN_DOC_TYPE` | Static | No Fynd source | Always `IN`. |
| `TRAN_DOC_NO` | Derived | `payload.shipment.shipment_id` or `payload.shipment.id` | Trusted shipment identity; formatted as `VR-<shipmentId>-1`. Aliases must agree. |
| `TRAN_LINE_NO` | Derived | Position of `payload.shipment.bags[]` | One-based sequential line number. |
| `ERP_TRANSACTION_REF` | Derived | Document number and line number | `<TRAN_DOC_NO>_<TRAN_LINE_NO>`. |
| `TRAN_DOC_DATE` | Derived | `payload.shipment.shipment_status.created_ts` | Timestamp must include an explicit offset and be a valid instant. It is converted to `Asia/Riyadh`, then formatted `YYYYMMDD`. |
| `DATE_OF_SUPPLY` | Derived | Same as `TRAN_DOC_DATE` | Same Riyadh calendar date as the confirmed shipment instant. |
| `TRAN_BRANCH` | Fynd + master data | `payload.shipment.fulfilling_store.code` | Identifier must be valid and must exist in the approved branch registry. |
| `TRAN_SERVICE_BRANCH` | Fynd + master data | Same as `TRAN_BRANCH` | Repeats the approved fulfilling-store branch code. |
| `PRODUCT_CODE` | Fynd + master data | See [Product identifier resolution](#product-identifier-resolution) | All present aliases must agree. The result must exist in the approved 300-product registry. |
| `TRAN_UQC` | Master data | Approved product entry `uqc` | Must be `OTH`. |
| `INV_CURRENCY_CODE` | Fynd | See [Currency resolution](#currency-resolution) | Every present currency candidate must equal `SAR`. Emitted as `SAR`. |
| `VAT_CURRENCY_CODE` | Fynd | Same validated currency | Always `SAR` after currency validation. |
| `TRAN_QUANTITY` | Fynd | `payload.shipment.bags[].quantity` | Must be a positive safe integer. |
| `TRAN_UNIT_PRICE` | Fynd | Bag `price_effective` | Positive amount, normalized to two decimals. This is a per-unit value. |
| `TRAN_GROSS_AMOUNT` | Derived | `price_effective × quantity` | Exact integer-cent multiplication. |
| `TRAN_DISC1_REASON_CODE` | Static, conditional | Present when promotion discount is non-zero | Always `95`. Omitted when promotion discount is `0.00`. |
| `TRAN_DISC1_REASON_TEXT` | Static, conditional | Present when promotion discount is non-zero | Always `Promotion Discount`. |
| `TRAN_DISC1_AMOUNT` | Fynd + derived, conditional | Bag `promotion_effective_discount` | Per-unit discount multiplied by quantity. Omitted when total is `0.00`. |
| `TRAN_DISC2_REASON_CODE` | Static, conditional | Present when coupon discount is non-zero | Always `95`. Omitted when coupon discount is `0.00`. |
| `TRAN_DISC2_REASON_TEXT` | Static, conditional | Present when coupon discount is non-zero | Always `Coupon Discount`. |
| `TRAN_DISC2_AMOUNT` | Fynd + derived, conditional | Bag `coupon_effective_discount` | Per-unit discount multiplied by quantity. Omitted when total is `0.00`. |
| `TRAN_NET_AMOUNT` | Fynd + derived | Bag `value_of_good × quantity` | Exact product net amount, excluding delivery. Gross minus both discounts must reconcile to this value within SAR `0.01`. |
| `TRAN_TAX_CODE_CATEGORY` | Policy | `taxation_nationality` decision plus financial evidence | `Z` for an eligible Saudi citizen under the government-borne healthcare VAT rule; otherwise `S`. See [Tax decision](#tax-decision). |
| `TRAN_TAX_RATE` | Policy + Fynd evidence | Bag `gst_tax_percentage` | `0.00` for category `Z`; `15.00` for category `S`. Fynd financial values must already match the selected policy. |
| `TRAN_TAX_AMOUNT` | Fynd + derived | Bag `gst_fee × quantity` | Must reconcile with the selected tax category/rate. |
| `TRAN_NET_PLUS_TAX` | Derived | Product net plus product tax | Excludes delivery, which is represented by the `INV_CHGS_*` fields. |
| `TRAN_VAT_EXEMPT_REASON_CODE` | Policy, conditional | Eligible Saudi-citizen healthcare transaction | `VATEX-SA-HEA`; emitted only for category `Z`. |
| `TRAN_VAT_EXEMPT_REASON_TEXT` | Policy, conditional | Eligible Saudi-citizen healthcare transaction | `Private healthcare to citizen`; emitted only for category `Z`. |
| `CUST_NAME_WALKIN` | Fynd, conditional | `payload.shipment.order.meta.custom_cart_meta.custom_conditions.recipient_name` | Emitted when either validated recipient field is available. Required and nonblank for category `Z`; optional for category `S`. Control characters are rejected. |
| `CUST_ADDITIONAL_ID_NO_WALKIN` | Fynd, conditional | `payload.shipment.order.meta.custom_cart_meta.custom_conditions.national_id` | Must be exactly 10 ASCII digits when present. Required for category `Z`; optional for category `S`. |
| `CUST_ADDL_ID_TYP_WALKIN` | Static, conditional | Present with recipient fields | Always `NAT`. |
| `INV_CHGS_TAX_CATEGORY` | Policy, conditional | Validated non-zero delivery charge | Always `S`; omitted when delivery paid amount is zero. |
| `INV_CHGS_VAT_RATE` | Policy, conditional | `delivery_charges_breakup.gst_tax_percentage` | Must equal `15.00`; omitted when delivery is zero. |
| `INV_CHGS_VAT_AMOUNT` | Fynd, conditional | `delivery_charges_breakup.gst_fee` | Validated delivery tax amount; omitted when delivery is zero. |
| `INV_CHGS_REASON_CODE` | Static, conditional | Validated non-zero delivery charge | Always `DL`. |
| `INV_CHGS_REASON_TEXT` | Static, conditional | Validated non-zero delivery charge | Always `Delivery`. |
| `INV_CHGS_PERCENT` | Derived, conditional | Delivery net ÷ total product net | Rounded to two decimal percentage places. The represented charge must reconcile within SAR `0.01`. |
| `INV_CHGS_AMOUNT` | Fynd, conditional | `delivery_charges_breakup.value_of_good` | Validated delivery net amount; omitted when delivery is zero. |
| `INV_NET_AMOUNT` | Derived | Sum of all product net amounts plus delivery net | Repeated on every OEIS row. |
| `INV_TOTAL_TAX_AMOUNT` | Derived | Sum of all product taxes plus delivery tax | Repeated on every OEIS row. |
| `INV_TOTAL_AMOUNT` | Derived | Invoice net plus invoice tax | Must reconcile with the authoritative Fynd paid amount within SAR `0.01`. |
| `INV_CUSTOMER_PAID_AMOUNT` | Static business rule | No direct Fynd source | Always `0.00`. This represents the amount already applied inside OEIS, not Fynd's payment collection status. |
| `INV_CUSTOMER_AMOUNT_DUE` | Derived business rule | Same calculated amount as `INV_TOTAL_AMOUNT` | Always the full calculated invoice total. |
| `PAY_METHOD` | Static business rule | Fynd payment mode is validated separately | Always `48` after the Fynd mode resolves to either `CARD` or `APPLE_PAY`. |

## Fynd source resolution details

### Shipment eligibility gate

The webhook is processed only when:

- event type is exactly `application/shipment/update/v1`;
- the trusted company, application, event, and shipment identifiers are valid;
- `payload.shipment.shipment_status.status` is exactly `bag_confirmed`;
- every bag represents a service: `bag.item.attributes["product-type"]`, case-insensitively, must be `service`.

Other shipment statuses are acknowledged and ignored rather than invoiced.

### Currency resolution

The implementation accepts these Fynd representations:

- `payload.shipment.currency` as `SAR`;
- `payload.shipment.currency.currency_code`;
- `payload.shipment.order.currency` as `SAR`;
- `payload.shipment.order.currency.currency_code`;
- `payload.shipment.order.meta.currency` as `SAR`;
- `payload.shipment.order.meta.currency.currency_code`.

Every present candidate must agree, and the resolved value must be `SAR`.

### Payment-mode resolution

Modes are collected from:

- `payload.shipment.payment_info[].mode`;
- `payload.shipment.payment_methods.<method>.mode`;
- `payload.shipment.order.payment_info[].mode`;
- `payload.shipment.order.payment_methods.<method>.mode`.

Every present candidate must resolve to one unique mode. Only `CARD` and `APPLE_PAY` are accepted. Both currently map to OEIS `PAY_METHOD = "48"`.

### Authoritative Fynd amount

The total paid amount may be supplied at any of these paths:

- `payload.shipment.amount_paid`;
- `payload.shipment.financial_breakup.amount_paid`;
- `payload.shipment.total_amount`;
- `payload.shipment.prices.amount_paid`;
- `payload.shipment.order.amount_paid`;
- `payload.shipment.order.financial_breakup.amount_paid`;
- `payload.shipment.order.total_amount`;
- `payload.shipment.order.prices.amount_paid`.

All present candidates must normalize to the same two-decimal amount. The calculated OEIS invoice total must match this amount within SAR `0.01`.

### Product identifier resolution

Supported bag-level aliases are:

- `bag.seller_identifier`;
- `bag.sku_code`;
- `bag.article.seller_identifier`;
- `bag.article.identifiers.sku_code`.

Supported aliases inside each `bag.financial_breakup` entry are:

- `seller_identifier`;
- `sku_code`;
- `identifiers.sku_code`;
- `article.seller_identifier`;
- `article.identifiers.sku_code`.

All present aliases must agree. For an array-shaped financial breakup, entries matching the resolved product code are selected. The final code must exist in the approved product registry.

### Bag financial mapping

`bag.financial_breakup` may be one object or an array. The following fields are required for the selected product:

| Fynd financial field | Meaning in the canonical snapshot | OEIS use |
|---|---|---|
| `price_effective` | Per-unit gross price | `TRAN_UNIT_PRICE`, then multiplied into `TRAN_GROSS_AMOUNT` |
| `promotion_effective_discount` | Per-unit promotion discount | `TRAN_DISC1_AMOUNT` after quantity multiplication |
| `coupon_effective_discount` | Per-unit coupon discount | `TRAN_DISC2_AMOUNT` after quantity multiplication |
| `value_of_good` | Per-unit product net | `TRAN_NET_AMOUNT` after quantity multiplication |
| `gst_tax_percentage` | Product VAT rate | `TRAN_TAX_RATE`; only `0.00` or `15.00` |
| `gst_fee` | Per-unit product VAT | `TRAN_TAX_AMOUNT` after quantity multiplication |
| `amount_paid` | Per-unit total including any allocated delivery | Split into product `TRAN_NET_PLUS_TAX` and delivery totals when delivery is allocated |
| `delivery_charge` | Optional per-unit allocated delivery net | Reconciled against the shipment-level delivery breakup |

When duplicate discount/financial values are also present in `bag.prices`, they must agree with the financial-breakup values.

### Delivery mapping

The declared delivery net may be present at:

- `payload.shipment.delivery_charges`; or
- `payload.shipment.prices.delivery_charge`.

If both exist, they must agree. A non-zero delivery requires:

- `payload.shipment.delivery_charges_breakup.gst_tax_percentage`;
- `payload.shipment.delivery_charges_breakup.value_of_good`;
- `payload.shipment.delivery_charges_breakup.gst_fee`;
- `payload.shipment.delivery_charges_breakup.amount_paid`.

Delivery must be category `S` at `15.00%`. Net plus tax must equal paid, calculated tax must match 15%, and the sum of bag-level delivery allocations must match the shipment-level delivery breakup. A present zero-value delivery breakup is validated and then omitted from the OEIS row.

## Tax decision

Tax eligibility is sourced from:

`payload.shipment.order.meta.custom_cart_meta.custom_conditions`

| Fynd field | Purpose |
|---|---|
| `taxation_nationality` | Required boolean government-borne VAT decision. |
| `recipient_name` | Buyer name; mandatory when the decision is `true`. |
| `national_id` | Ten-digit Saudi national ID; mandatory when the decision is `true`. |

Evidence also includes the trusted Fynd webhook event ID and `payload.shipment.shipment_status.created_ts`. The timestamp is canonicalized to UTC and must not be in the future or more than 24 hours old when tax is resolved.

### Eligible Saudi citizen

When `taxation_nationality === true`:

- category is `Z`;
- rate is `0.00`;
- reason is `VATEX-SA-HEA / Private healthcare to citizen`;
- recipient name and ten-digit national ID are mandatory;
- product net and paid amounts must agree within one halala;
- product tax rate and tax amount must both be zero.

### Standard taxable transaction

When `taxation_nationality === false`:

- category is `S`;
- rate is `15.00`;
- no VAT exemption reason is emitted;
- valid recipient name and/or national ID are preserved when supplied, but are not mandatory;
- product tax must equal rounded 15% of product net within one halala;
- product paid amount must equal net plus tax within one halala.

## Master-data controls

- Approved branches are exactly `DAMSGH`, `JEDSGH`, `E014`, and `MD101`.
- The product registry must contain exactly 300 approved product codes and match the reviewed registry SHA-256.
- Every approved product must have:
  - `uqc = OTH`;
  - `supply_class = PRIVATE_HEALTHCARE_SERVICE`;
  - `allowed_zero_rate_reason = VATEX-SA-HEA`.
- Unknown branches or products stop the invoice before any Fynd lock or OEIS submission.

## Reconciliation and fail-closed rules

- Monetary input supports at most two decimal places and is processed as integer SAR cents, never floating point.
- Amount tolerance is fixed at SAR `0.01`.
- Quantity must be a positive safe integer.
- Gross minus promotion and coupon discounts must equal product net.
- Product net plus product tax must equal product paid unless delivery is explicitly allocated.
- Mixed product tax rates within one shipment are rejected.
- Delivery allocation, tax, and totals must reconcile independently.
- Sum of invoice net and tax must equal invoice total.
- Calculated invoice total must equal Fynd's authoritative paid amount.
- All OEIS rows must use the same generated document number and sequential line numbers.
- The exact compact JSON request is SHA-256 hashed before persistence.
- Retries use the persisted JSON bytes and hash; the payload is not silently rebuilt or changed after the shipment has been locked.

## Fields that are not direct Fynd mappings

The following values are integration or business-policy decisions and should not be described as values supplied by Fynd:

- company/source/country identity;
- supplier role and invoice/template/document types;
- document number and ERP reference formats;
- discount reason codes/text;
- healthcare VAT category, rate, and reason;
- delivery reason/category constants;
- `INV_CUSTOMER_PAID_AMOUNT = 0.00`;
- `INV_CUSTOMER_AMOUNT_DUE = INV_TOTAL_AMOUNT`;
- `PAY_METHOD = 48` after supported-mode validation.

## Implementation references

This document reflects these current implementation boundaries:

- `src/einvoice/snapshot-normalizer.js` — Fynd input paths and canonical snapshot.
- `src/einvoice/tax-policy-resolver.js` — Saudi healthcare VAT decision.
- `src/einvoice/payload-builder.js` — OEIS field generation and reconciliation.
- `src/einvoice/master-data-gateway.js` — approved branches and products.
- `src/einvoice/config.js` — fixed integration identity and operational configuration.
