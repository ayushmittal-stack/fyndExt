# OEIS Product Master uploader

This is a one-time, **product-only** uploader. It builds an OEIS
`ProductMasterList` from the translated Viva catalog; it does not upload company
or branch masters, create invoices, change application runtime data, or modify
the source CSV. The transaction/invoice cURL used elsewhere is **not** the
Product Master upload and must not be used for this task.

## Input and mapping

Use the translated CSV with its Arabic product-name column. Every source
`Verification Status` must remain `pending`; the source file is never edited,
and that status is not sent to OEIS.

Each product object has exactly these seven fields:

| Product Master field | Source or fixed value |
| --- | --- |
| `COMPANY_CODE` | `Viva Radix` |
| `SOURCE_ERP` | `Fynd` |
| `SUPPLIER_COUNTRY_CODE_ENGLISH` | `SA` |
| `PRODUCT_CODE` | `Seller Identifier` |
| `PRODUCT_DESCRIPTION_1_ENGLISH` | `Name` |
| `PRODUCT_DESCRIPTION_1_LANG02` | `Translated Product Name (Arabic)` |
| `PRODUCT_TYPE` | `Service` |

The 29 blank source tax percentages are defaulted to 15 only for the local
validation report and, when OEIS accepts rows, the accepted-product registry
fragment. Tax information is never a Product Master request field. Likewise,
server-owned fields such as `IsValidated` and `ValidationError` are never sent.

## Offline validation and payload generation

Default mode performs local validation and writes private artifacts; it makes no
network request. Run this command from the repository root:

```sh
python3 scripts/oeis-product-upload/upload_products.py \
  --input "/Users/ayushmittal/Documents/ChatGPT/All Download related stuff/outputs/viva_full_details_20260813/Viva_300_products_full_details_with_arabic_names.csv" \
  --output-dir "/Users/ayushmittal/Documents/AppProducts/fyndExt/scripts/oeis-product-upload/out"
```

Successful output reports `product_count=300` plus the source and payload
SHA-256 hashes. The output directory and files are owner-only where the
platform supports it. Treat all generated artifacts as private and leave them
ignored and unstaged.

The source catalog is always validated as the complete, exact 300-row snapshot,
including all existing row and tax-default invariants. Selection happens only
after that validation:

- `--smoke-product-code CODE` writes or submits exactly the one row whose
  `PRODUCT_CODE` exactly equals `CODE`.
- `--exclude-product-code CODE` writes or submits the other 299 rows.
- The flags are mutually exclusive. Blank and unknown codes fail before any
  output artifact, credential read, or network request.
- With neither flag, the existing 300-product behavior is unchanged.

The payload file, payload hash, printed `product_count`, and request body always
describe the selected request. `validation-report.json` retains `product_count`
for compatibility and also records the full catalog count, request count,
selection mode, and selected or excluded code. Its source hash and tax-default
provenance continue to describe the complete original CSV snapshot.

## Controlled execution

Only a deliberate `--execute` can send a request. Set credentials through the
environment only—never on the command line or in an artifact. Use this exact
smoke-first workflow. Choose one real code from the validated catalog and first
generate a one-product offline preview:

```bash
CATALOG_PATH="/absolute/path/Viva_300_products_full_details_with_arabic_names.csv"
SMOKE_PRODUCT_CODE="<exact-PRODUCT_CODE>"
SMOKE_PREVIEW_OUTPUT="$(mktemp -d "/absolute/path/oeis-smoke-preview.XXXXXX")"
python3 scripts/oeis-product-upload/upload_products.py \
  --input "$CATALOG_PATH" \
  --output-dir "$SMOKE_PREVIEW_OUTPUT" \
  --smoke-product-code "$SMOKE_PRODUCT_CODE"
```

Confirm the preview reports `product_count=1`, contains only the exact chosen
code, and has the expected descriptions. Then perform the one-product controlled validation
in a different, fresh directory. The prompt below does not echo the API key;
the secret literal is never placed in shell history:

```bash
export OEIS_BASE_URL="https://<approved-oeis-host>"
printf 'OEIS API key: ' >&2
IFS= read -r -s OEIS_API_KEY
printf '\n' >&2
export OEIS_API_KEY
SMOKE_RUN_OUTPUT="$(mktemp -d "/absolute/path/oeis-smoke-validation.XXXXXX")"
python3 scripts/oeis-product-upload/upload_products.py \
  --input "$CATALOG_PATH" \
  --output-dir "$SMOKE_RUN_OUTPUT" \
  --smoke-product-code "$SMOKE_PRODUCT_CODE" \
  --execute
```

Do not continue merely because OEIS returned HTTP 2xx. The smoke command must
exit zero, `oeis-product-results.csv` must show the chosen code once with
`OEIS_IS_VALIDATED=true`, the accepted registry must contain only that code,
and the saved OEIS logs must reconcile as total/success/error `1/1/0` with no
system exception.

If any smoke check fails or the outcome is uncertain, **do not run the bulk
step**. Preserve that directory and obtain OEIS guidance. Do not blindly resend
the smoke row: OEIS upsert/idempotency behavior is undocumented. Unset
`OEIS_API_KEY` immediately when stopping.

Only after the one-product smoke has confirmed business success, submit the
remaining 299 products in a separate fresh directory. Excluding the accepted
smoke code prevents this planned bulk step from resending it:

```bash
BULK_RUN_OUTPUT="$(mktemp -d "/absolute/path/oeis-bulk-after-smoke.XXXXXX")"
python3 scripts/oeis-product-upload/upload_products.py \
  --input "$CATALOG_PATH" \
  --output-dir "$BULK_RUN_OUTPUT" \
  --exclude-product-code "$SMOKE_PRODUCT_CODE" \
  --execute
unset OEIS_API_KEY OEIS_BASE_URL CATALOG_PATH SMOKE_PRODUCT_CODE \
  SMOKE_PREVIEW_OUTPUT SMOKE_RUN_OUTPUT BULK_RUN_OUTPUT
```

Every `--execute` attempt must use a new, unique output directory. This includes
every retry after configuration, network, response, partial-publication, or
partial-business failure. If any prior response, results, or accepted-registry
artifact exists in the selected directory, the uploader aborts before reading
configuration or sending a request and preserves that evidence unchanged. A
fresh attempt establishes an empty accepted registry before network access.

HTTPS is required by default. An HTTP endpoint is allowed only when the command
also includes `--allow-insecure-http`; add that exact transport opt-in only for
an explicitly approved HTTP endpoint. Complete the controlled validation first. The fixed Product Master
request is `POST /API/InvoicingMasterAPI/UpdateData`. The client uses no
redirects, no proxy discovery, and no automatic retries. The default mode with
no selector remains a single 300-row request for backward compatibility, but it
is not the post-smoke bulk command because it would include the accepted smoke
row. Do not assume vendor idempotency, upsert semantics, or a supported batch
limit: they are undocumented. If an execution is uncertain or partial, stop,
preserve the private artifacts, and obtain OEIS guidance on duplicate/upsert
recovery before another POST.

HTTP 2xx is not enough. Business success requires a valid reconciled response:
every requested code appears exactly once, every row has `IsValidated = true`,
the response list and total count exactly equal the actual request size (1, 299,
or 300), successful plus error counts equal that total, error count is zero,
and the system-exception fields are empty. Any partial, malformed, or ambiguous
result is a failure and exits nonzero.

The `accepted-products-registry.json` artifact starts empty for a fresh execute
attempt and remains empty on configuration or HTTP failure. After a structurally
valid response, it is replaced with only the rows OEIS accepted. A partial
response can produce that fragment and still exit nonzero. It is never
auto-merged into runtime master data: review it and perform any integration
through a separate controlled process.

## Boundaries

Do not put real service addresses, IP addresses, API keys, VAT/TIN values,
bank data, or customer data in commands, artifacts, tickets, or documentation.
Do not use this tool to upload transactions or invoices. It is limited to the
seven-field Product Master payload described above.

## Conditional-VAT runtime classification registry

The accepted OEIS Product Master records and every prior execution artifact are
immutable. The following offline-only converter derives a separate, private
runtime classification registry from the cumulative 300-product acceptance
evidence. It makes no network requests and never re-uploads Product Master
data. It validates the historic `OTH/S/15.00` evidence only to establish the
source snapshot; its output deliberately contains no tax category or tax rate.

Run from the repository root in a fresh output location:

```sh
python3 scripts/oeis-product-upload/build_runtime_master.py \
  --accepted-registry "scripts/oeis-product-upload/out/k8s-m3-runs/bulk-299-excluding-FMDIF-001-q7xn8p9w/cumulative-accepted-products-registry.json" \
  --branch-master "/Users/ayushmittal/Downloads/B1_BranchMaster_SGH_Stores_Fixed_BranchType (15 Jun) (1).csv" \
  --output "scripts/oeis-product-upload/out/conditional-vat-runtime-master/oeis-masters.json"
```

The command accepts exactly 300 historical products and the four approved
branches (`DAMSGH`, `JEDSGH`, `E014`, `MD101`) for `Viva Radix/Fynd/SA`. It
writes deterministic UTF-8 JSON as an owner-only (`0600`) file in an owner-only
(`0700`) directory tree, using atomic no-replace publication steps. It also
writes `oeis-masters.hash-report.json` beside the candidate, with product and
branch counts plus SHA-256 hashes for the accepted-registry input, Branch
Master CSV, exact product-code set, and generated runtime JSON. The code-set
hash input is the UTF-8 compact JSON array of all product codes sorted
lexically, with no trailing newline. The private (`0600`) report contains no
registry body, source path, secret, or customer data. An existing candidate or
report is a hard failure and must be preserved for review.

Independently validate a candidate before loading it into any runtime:

```sh
python3 -m json.tool \
  scripts/oeis-product-upload/out/conditional-vat-runtime-master/oeis-masters.json \
  >/dev/null
python3 -m json.tool \
  scripts/oeis-product-upload/out/conditional-vat-runtime-master/oeis-masters.hash-report.json \
  >/dev/null
rg -n 'tax_category|tax_rate' \
  scripts/oeis-product-upload/out/conditional-vat-runtime-master/oeis-masters.json
```

Both JSON validation commands must succeed; `rg` must return exit status `1`
with no matches. Independently compare the report's runtime SHA-256 with the
candidate before an operator atomically replaces the private runtime
`oeis-masters.json`, preserving mode `0600`.
