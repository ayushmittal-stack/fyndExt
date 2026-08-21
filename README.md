# Fynd OEIS shipment invoice gate

This Fynd extension turns a signed `bag_confirmed` shipment webhook into one OEIS B2C simplified tax invoice per shipment. It validates and stores a minimal snapshot, builds a deterministic OEIS request, locks the shipment, accepts only a semantically valid signed OEIS result, and then stores the invoice metadata/XML and transitions the shipment to `bag_invoiced` through a durable outbox.

The invoice gate is disabled by default. Disabled mode still runs the extension and signed webhook registration, but it does not require OEIS credentials or start invoice processing.

## Prerequisites and installation

- Node.js 24 or newer and npm compatible with the checked-in lockfiles.
- A Fynd partner extension configured for offline access.
- Fynd company order scopes `company/orders/read` and `company/orders/write`.
- For local preview, the FDK CLI and a test company/application installation.

Install the backend and frontend exactly from their lockfiles:

```sh
npm ci
npm --prefix frontend ci
cp .env.example .env
```

Replace every `replace-with-...` value in `.env`. Never put real credentials in `.env.example`, logs, fixtures, master data committed to Git, or an extension context file.

For local FDK development, run `fdk extension preview` and complete an offline installation in the test company/application. Reinstalling or changing an installation requires resynchronizing the offline session and webhook subscription before testing events. Build the frontend with `npm --prefix frontend run build`, then run the backend with `npm run start:dev` or `npm run start:prod`.

## Runtime configuration

Base configuration is always required:

| Variable | Meaning |
| --- | --- |
| `NODE_ENV` | Use `development` for the copied local env. `production` selects the built frontend assets; Docker and `npm run start:prod` set it. |
| `BACKEND_PORT` | HTTP listener port; the documented default is `8080`. |
| `EXTENSION_API_KEY` | Fynd extension API key. Secret. |
| `EXTENSION_API_SECRET` | Fynd extension API secret. Secret. |
| `EXTENSION_BASE_URL` | Public extension base URL used by FDK callbacks. Use HTTPS outside local development. |
| `FP_API_DOMAIN` | Fynd Platform API cluster/domain. |
| `WEBHOOK_NOTIFICATION_EMAIL` | FDK webhook notification address. |
| `MONGODB_URI` | MongoDB connection URI. Use an SRV URI for deployed environments and keep credentials in the secret store. |
| `MONGODB_DB_NAME` | MongoDB database name; this application requires `sgh_oeis_einvoicing`. |

Invoice processing configuration:

| Variable | Meaning |
| --- | --- |
| `EINVOICE_ENABLED` | Exact `true` enables the gate. Any other value keeps it disabled; default `false`. |
| `EINVOICE_DRY_RUN` | Required explicit hold/live boolean when the gate is enabled. Exact `true` locks and holds newly accepted jobs before OEIS; exact `false` permits live processing after every activation gate passes. |
| `EINVOICE_WORKER_POLL_MS` | Worker polling interval in milliseconds. |
| `EINVOICE_JOB_LEASE_MS` | Job/outbox lease duration in milliseconds. |
| `EINVOICE_MAX_ATTEMPTS` | Maximum processing attempts; phase-one maximum is `5`. |
| `EINVOICE_RETRY_BASE_MS` | Base delay for bounded retry backoff. |
| `EINVOICE_AMOUNT_TOLERANCE` | Fixed reconciliation tolerance; phase one requires exactly `0.01` SAR. |
| `EINVOICE_MASTER_DATA_PATH` | Path to the deployment-specific, tax-neutral branch/product classification registry. |
| `EINVOICE_ALLOWED_PAYMENT_MODES` | Fixed allowlist `CARD,APPLE_PAY`; COD is rejected before shipment lock. |

OEIS configuration is consumed only when the gate is enabled:

| Variable | Meaning |
| --- | --- |
| `OEIS_BASE_URL` | Fixed OEIS endpoint base URL. HTTPS is mandatory unless the exact explicit transport opt-in below is enabled. |
| `OEIS_API_KEY` | OEIS API key. Secret. |
| `OEIS_ALLOW_INSECURE_HTTP` | Keep `false` for HTTPS. Exact `true` is the sole explicit opt-in that permits a configured HTTP URL; no deployment label enables it. |
| `OEIS_TIMEOUT_MS` | OEIS request timeout in milliseconds. |
| `OEIS_MAX_REQUEST_BYTES` | Maximum UTF-8 request size. |
| `OEIS_MAX_RESPONSE_BYTES` | Maximum response size; it must be at least `OEIS_MAX_REQUEST_BYTES`. |
| `OEIS_COMPANY_CODE` | Exact Product Master company identity `Viva Radix`. |
| `OEIS_SOURCE_ERP` | Exact Product Master source ERP identity `Fynd`. |
| `OEIS_SUPPLIER_COUNTRY_CODE` | Exact Product Master supplier country identity `SA`. |

The checked-in `.env.example` is the complete placeholder contract. It uses the safe local `NODE_ENV=development`, requires MongoDB for shared extension state, and sets a response byte limit greater than its request limit.

The runtime registry must use exactly the accepted branches `DAMSGH`, `JEDSGH`,
`E014`, and `MD101` and exactly the 300 accepted product codes. Each product
stores only `uqc=OTH`, `supply_class=PRIVATE_HEALTHCARE_SERVICE`, and
`allowed_zero_rate_reason=VATEX-SA-HEA`. It does not store a fixed tax category
or rate: the transaction policy resolves `S/15.00` or eligible
`Z/0.00/VATEX-SA-HEA` from authoritative order evidence and reconciled
financials. The matching OEIS Product Master namespace is exactly
`COMPANY_CODE=Viva Radix`, `SOURCE_ERP=Fynd`, and
`SUPPLIER_COUNTRY_CODE_ENGLISH=SA`.

Startup also verifies the reviewed product-code universe using SHA-256 over the
UTF-8 compact JSON array of all 300 product codes sorted lexically. Reordering
JSON object keys is allowed; adding, removing, replacing, or case-changing a
code is rejected.

Only service shipments enter the invoice pipeline. Every bag must provide an
exact own string at `bag.item.attributes["product-type"]` whose trimmed,
case-insensitive value is `service`. Missing, malformed, non-service, or mixed
bags fail before job creation with `SHIPMENT_PRODUCT_TYPE_INVALID`; the durable
shipment audit records `VALIDATION_FAILED` and `WEBHOOK_REJECTED`, and no Fynd
lock, OEIS submission, or Fynd transition is attempted.

For `bag_confirmed`, both the trigger status and eligibility verification time
must come from exact own data fields on the same plain
`shipment.shipment_status` object. Flat `shipment.status`, `created_ts`, and
`updated_ts` are never fallback evidence. At request preparation, the
verification instant must not be in the future or more than 24 hours old;
exactly 24 hours old is accepted. Invalid, future, or stale evidence becomes a
non-retryable `DATA_FAILED` job before the Fynd lock. Once request bytes are
prepared, retries reuse those exact stored bytes and do not re-evaluate age.

Warning: `EINVOICE_DRY_RUN=true` performs a real shipment lock and affects only newly accepted jobs. Held jobs require manual cleanup before the control is changed to `false` and live processing resumes.

## Storage and deployment

MongoDB is authoritative for offline FDK sessions, invoice jobs, artifacts, the durable outbox, shipment audit events, and operational activity. Use a replica-set or sharded MongoDB deployment that supports transactions, majority writes, and primary reads. Configure backups and the 90-day activity retention policy in MongoDB; the application container does not require a persistent data volume.

Build and run the hardened image:

```sh
docker build -t fynd-oeis-gate .
docker run --rm -p 8080:8080 \
  --env-file .env \
  --env NODE_ENV=production \
  fynd-oeis-gate
```

The explicit `--env NODE_ENV=production` after `--env-file .env` overrides the example file's safe local development value so startup serves the built assets copied into the runtime image. Use the same explicit production override in any deployment mechanism that imports the local example contract. The image installs production dependencies on Node 24 Alpine, copies only runtime code and the built frontend, runs as the unprivileged `node` user, and starts `node index.js`. Production must use HTTPS for both the public extension URL and OEIS. Any configured HTTP OEIS transport requires the exact `OEIS_ALLOW_INSECURE_HTTP=true` opt-in and explicit approval; it is never inferred from a deployment label.

FDK extension 1.1.5 is process-global and initialized once per process. Its internal initialization retry timer has no public cancellation API, so a failed SDK initialization can keep an internal timer alive and delay process shutdown even after application-owned HTTP, worker, repository, storage, and MongoDB resources are drained. Do not claim every lifecycle resource is cancellable; treat an FDK upgrade or explicitly accepted pre-live shutdown behavior as an activation gate.

## Security activation blocker

Historical local logs and extension context were previously tracked. Their working-tree copies are removed and their filenames are now ignored, but this does not rewrite Git history. Before any activation, rotate every Fynd/OEIS credential or session that may ever have appeared in those artifacts, invalidate the old values, and verify the replacement secrets are delivered through the deployment secret store. Do not enable `EINVOICE_ENABLED=true` until rotation and all activation gates below are signed off.

## Activation gates

No live activation is allowed until all of these have controlled pre-live evidence:

1. Confirm the vendor endpoint is exactly `POST /API/V2/Transaction/UpdateInvoiceData`, including V2 path casing, `Authorization: APIkey ...` behavior, redirects disabled, timeout/byte limits, and OEIS-side duplicate-document handling for `VR-{shipmentId}-1`.
2. Confirm the exact invoice identity `OEIS_COMPANY_CODE=Viva Radix`, `OEIS_SOURCE_ERP=Fynd`, and `OEIS_SUPPLIER_COUNTRY_CODE=SA` is registered and accepted by the vendor.
3. Approve and deploy the tax-neutral branch/product classification registry containing exactly the four approved branches and 300 accepted products; confirm it contains no fixed tax category or rate.
4. Exercise positive CARD and APPLE_PAY shipments and a negative COD shipment; COD must fail before lock or OEIS submission.
5. Verify Fynd writes and read-back: `store_invoice_id`, root `meta.einvoice_info.invoice.SignedQRCode`, root `meta.xml` filename/content (mapped by Avis to Grindor's `shipment_meta.xml`), the locked pre-state, the unlock-and-`bag_invoiced` transition, and ambiguous/mismatched cases that must stay retryable or indeterminate rather than falsely complete. Obtain explicit Fynd confirmation that entity metadata is merged rather than replacing unrelated metadata, that the permitted XML metadata size accommodates the signed artifact, and that an `unlock_before_transition` failure leaves the shipment locked (or document the actual atomicity/recovery behavior before activation).
6. Reconcile decimals and the customer-paid assumption: exact fixed-decimal SAR arithmetic, `INV_CUSTOMER_PAID_AMOUNT` equals the fully paid invoice total, `INV_CUSTOMER_AMOUNT_DUE` is `0.00`, and `PAY_METHOD=48` is accepted for the approved prepaid modes. Obtain explicit Thomson Reuters confirmation that fixed-decimal JSON strings are accepted for every numeric OEIS request field used by this integration.
7. Validate downstream Kafka/PDF output contains the signed QR data and the exact signed XML artifact, while acknowledging this gate validates structure and vendor semantics rather than cryptographically verifying the XML signature.
8. Assign and record downstream reporting ownership: who monitors OEIS/ZATCA reporting status, retries/escalates reporting failures, reconciles Kafka/PDF consumers, and owns operational incident response.
9. Exercise failed FDK initialization and signal-driven shutdown. Upgrade to an FDK version with cancellable initialization retry lifecycle when available, or obtain explicit operational acceptance of the 1.1.5 process-global/one-shot behavior and its potentially shutdown-delaying uncancellable retry timer.

## Verification

All automated tests use synthetic fixtures and must not make live Fynd or OEIS calls.

```sh
npx jest --config jest.config.js --runInBand --no-cache --coverage=false
npm test -- --runInBand
npm --prefix frontend test -- --runInBand
npm --prefix frontend run build
npm audit --omit=dev
```

Keep the gate disabled after verification until credential rotation, offline installation/session-webhook resynchronization, MongoDB topology and backup readiness, and all activation gates are complete.
