# OEIS One-Time Product Master Upload Design

## Status

Approved for implementation after the user selected the existing Viva
Radix/Fynd master namespace and requested the script be created.

## Goal

Build a small, standalone, one-time command-line tool that converts the 300-row
Viva catalog into the OEIS `ProductMasterList` contract, validates it locally,
optionally uploads it to OEIS, and records row-level acceptance without changing
the source CSV or invoking the invoice endpoint.

## Scope

The tool lives in `scripts/oeis-product-upload/` and remains separate from the
runtime shipment/invoice workflow. It may reuse the existing OEIS environment
variable names, but it has its own Product Master endpoint, request builder, and
response validator.

In scope:

- parse the supplied Excel-compatible CSV, including quoted multiline fields;
- build a deterministic Product Master request for all 300 products;
- validate mandatory fields, uniqueness, lengths, Arabic content, and fixed
  business values before any network request;
- write the payload and a validation report locally;
- upload only after an explicit `--execute` flag;
- reject incomplete or partially failed OEIS responses;
- write a response report and an accepted-product registry fragment.

Out of scope:

- changing the source catalog or its `Verification Status` values;
- creating, updating, or uploading `CompanyMasterList` or `BranchMasterList`;
- copying company tax, registration, address, contact, or bank data;
- copying branch codes, tax, registration, address, or bank data;
- calling `/API/V2/Transaction/UpdateInvoiceData`;
- automatically generating an invoice after product upload;
- translating, correcting, or clinically approving product names;
- sending catalog prices, media, dimensions, inventory, GTIN, or tax values in
  `ProductMasterList`;
- automatically overwriting the runtime `oeis-masters.json` file.

## Authoritative Inputs

Catalog:

```text
/Users/ayushmittal/Documents/ChatGPT/All Download related stuff/outputs/
viva_full_details_20260813/Viva_300_products_full_details_with_arabic_names.csv
```

Contract references:

```text
/Users/ayushmittal/Downloads/OEIS API Specification Document v1.6 (3).docx
/Users/ayushmittal/Downloads/
KSA_Invoicing_Input_Template_V2.1_V1.4_with_Fynd_Source_Path (1).xlsx
```

Master-identity references:

```text
/Users/ayushmittal/Downloads/
M1_CompanyMaster_Viva_Radix_Fixed (15 Jun) (1).csv
/Users/ayushmittal/Downloads/
B1_BranchMaster_SGH_Stores_Fixed_BranchType (15 Jun) (1).csv
```

The Company and Branch files establish the identity values used by Product
Master. They are not runtime inputs to the tool and their other fields must not
be read into, copied into, or uploaded with `ProductMasterList`.

The tool must record the source CSV SHA-256 in every generated report. The
audited source hash is:

```text
3365fc7b6bdc6ccdab3396d68f106fca34479e860c201117ad0f898640423113
```

If the source changes, the tool may still run, but it must calculate and report
the new hash and re-run every validation. It must never rely on the audited hash
as a substitute for validation.

## Confirmed Business Decisions

Use these exact Product Master values:

```text
COMPANY_CODE=Viva Radix
SOURCE_ERP=Fynd
SUPPLIER_COUNTRY_CODE_ENGLISH=SA
PRODUCT_TYPE=Service
```

The user confirmed that only product additions are needed. The design therefore
assumes the `Viva Radix` Company Master and its Branch Masters already exist in
the target OEIS environment. The tool does not upload or mutate them. An OEIS
response indicating an unknown company/source is a hard failure; the tool must
not fall back to `37293`, `HIS_1104`, or any other namespace.

All products use standard VAT assumptions for the local invoice registry:

```text
TRAN_TAX_CODE_CATEGORY=S
TRAN_TAX_RATE=15.00
TRAN_UQC=OTH
```

The catalog contains `Tax percentage = 15` for 271 products and a blank value
for 29 products. The tool treats those 29 blanks as `15` in its validation
report and accepted-product registry fragment. A nonblank value other than 15
is an error. Tax percentage is not a Product Master field and must not be added
to the OEIS request.

All 300 source rows currently have `Verification Status = pending`. The tool
requires and preserves that source value. It does not send `Verification
Status`, `IsValidated`, or `ValidationError` in the request. OEIS owns the
response-side `IsValidated` and `ValidationError` fields; the tool records them
in a separate result report without editing the CSV.

## Source-to-OEIS Mapping

Each CSV row maps to exactly one Product Master object:

| OEIS field | Source/rule | Validation |
|---|---|---|
| `COMPANY_CODE` | constant `Viva Radix` | exact, length <= 15 |
| `SOURCE_ERP` | constant `Fynd` | exact, length <= 20 |
| `SUPPLIER_COUNTRY_CODE_ENGLISH` | constant `SA` | exact two characters |
| `PRODUCT_CODE` | `Seller Identifier` | required, unique, preserve case, length <= 50 |
| `PRODUCT_DESCRIPTION_1_ENGLISH` | `Name` | required, length <= 250 |
| `PRODUCT_DESCRIPTION_1_LANG02` | `Translated Product Name (Arabic)` | required, contains Arabic script, length <= 500 |
| `PRODUCT_TYPE` | constant `Service` | exact, length <= 15 |

Do not emit optional empty fields. In particular, omit `HSN_SAC_CODE`,
`GL_BASIC_NO`, `DAT01`-`DAT20`, `IsValidated`, and `ValidationError`.

The output envelope is:

```json
{
  "ProductMasterList": [
    {
      "COMPANY_CODE": "Viva Radix",
      "SOURCE_ERP": "Fynd",
      "SUPPLIER_COUNTRY_CODE_ENGLISH": "SA",
      "PRODUCT_CODE": "FMDIF-001",
      "PRODUCT_DESCRIPTION_1_ENGLISH": "Diabetic Foot Dressing – Standard (Small)",
      "PRODUCT_DESCRIPTION_1_LANG02": "تضميد القدم السكرية – قياسي (صغير)",
      "PRODUCT_TYPE": "Service"
    }
  ]
}
```

Rows remain in source order. JSON uses UTF-8 Arabic characters rather than
ASCII escapes, stable indentation, and a trailing newline. The tool records a
SHA-256 of the exact payload bytes. It opens the source as bytes exactly once,
hashes that snapshot, and parses the same snapshot through a standard-library
UTF-8 BOM-aware text wrapper with Excel CSV quoted-newline semantics.

## Local Validation Contract

Before writing an executable payload or opening a network connection, require:

- exactly 300 data rows and the required source headers;
- exactly 156 parsed fields per row under the standard CSV dialect;
- no missing or case-insensitively duplicate `Seller Identifier`;
- no missing English or Arabic name;
- at least one Arabic-script character in every Arabic name;
- no replacement characters, null bytes, bidi override/isolate controls,
  literal `????`, or spreadsheet formula prefixes in mapped values;
- every mapped value within the OEIS length limit;
- every `Product Type` source value equal to `service` case-insensitively;
- every source verification status equal to `pending`;
- every currency equal to `SAR`, country equal to `Saudi Arabia`, and tax rule
  equal to `Standard VAT (15%)`;
- every tax percentage either `15` or blank, with exactly 29 blanks defaulted
  to 15 in local reporting;
- no Product Master key outside the seven-field allowlist.

Any validation failure exits nonzero, reports row number plus product code when
available, writes no executable payload, and makes no network request.

## Command Interface

Use Python 3 standard library only so this one-time utility adds no application
dependency.

Validation and payload generation are the default:

```sh
python3 scripts/oeis-product-upload/upload_products.py \
  --input "/absolute/path/Viva_300_products_full_details_with_arabic_names.csv" \
  --output-dir "/absolute/path/oeis-product-upload-output"
```

Network execution requires explicit opt-in. The API key is entered through a
non-echoing prompt, so no secret literal is part of a command recorded in shell
history. The placeholders below are non-secret host and path values:

```bash
export OEIS_BASE_URL="https://<oeis-host>"
OEIS_RUN_OUTPUT="$(mktemp -d "/absolute/path/oeis-product-upload-attempt.XXXXXX")"
printf 'OEIS API key: ' >&2
IFS= read -r -s OEIS_API_KEY
printf '\n' >&2
export OEIS_API_KEY
python3 scripts/oeis-product-upload/upload_products.py \
  --input "/absolute/path/Viva_300_products_full_details_with_arabic_names.csv" \
  --output-dir "$OEIS_RUN_OUTPUT" \
  --execute
unset OEIS_API_KEY OEIS_RUN_OUTPUT
```

`--execute` requires both environment variables. The API key must never be
accepted on the command line, stored in output, or logged.

Every execute attempt, including any retry after configuration, network,
response, partial-publication, or partial-business failure, requires a new
unique output directory. Existing `oeis-response.json`,
`oeis-product-results.csv`, or `accepted-products-registry.json` evidence makes
the directory ineligible: abort before configuration or network access and do
not delete or overwrite it. Existing offline payload/report files alone are
allowed. A fresh attempt atomically establishes an empty accepted registry
before configuration or network access.

For an explicitly approved HTTP endpoint, execution additionally requires
`--allow-insecure-http`. Production must use HTTPS. Redirects are disabled and
the request has a finite timeout.

The fixed request is:

```http
POST /API/InvoicingMasterAPI/UpdateData
Content-Type: application/json; charset=utf-8
Accept: application/json
```

The `Authorization` header is the fixed `APIkey ` prefix followed by the
in-memory `OEIS_API_KEY` value; it is never printed or persisted.

## Generated Artifacts

The user-selected output directory contains:

```text
product-master-payload.json
validation-report.json
oeis-response.json                 # execute mode only
oeis-product-results.csv           # execute mode only
accepted-products-registry.json    # execute mode; initialized empty
```

`validation-report.json` is success-only. After successful validation it
contains source and payload hashes, counts, constants, and the 29 defaulted-tax
product codes; it does not copy long catalog descriptions or unrelated
attributes. A validation failure exits nonzero, reports safe row/code errors,
and writes neither `product-master-payload.json` nor `validation-report.json`.

`oeis-product-results.csv` contains only:

```text
PRODUCT_CODE,SOURCE_VERIFICATION_STATUS,OEIS_IS_VALIDATED,OEIS_ERROR
```

`SOURCE_VERIFICATION_STATUS` remains `pending`. `OEIS_IS_VALIDATED` and
`OEIS_ERROR` come only from the response.

`accepted-products-registry.json` uses the existing invoice registry shape. It
is established empty before configuration/network, then contains only rows for
which OEIS returned `IsValidated = true`:

```json
{
  "products": {
    "FMDIF-001": {
      "uqc": "OTH",
      "tax_category": "S",
      "tax_rate": "15.00"
    }
  }
}
```

The tool does not merge this fragment automatically because overwriting or
partially updating runtime master data during a failed batch is unsafe.

## Response and Partial-Failure Handling

HTTP success is not business success. Execute mode succeeds only when:

- the response is valid JSON and contains the expected Product Master result;
- aggregate `TotalRecordsCount` equals 300;
- aggregate success plus error counts equals total count;
- every requested `PRODUCT_CODE` appears exactly once in the response;
- every returned code belongs to the request;
- all 300 rows have `IsValidated = true`;
- aggregate error count is zero and system-exception fields are empty.

A partial failure writes the raw response, redacted result CSV, and an accepted
registry fragment for successful rows, then exits nonzero. A malformed or
ambiguous response exits nonzero and does not claim any product was accepted.

Because vendor idempotency and maximum batch size are not documented, the first
real run must be an explicitly approved pre-live validation. The script sends one 300-item request to match the intended
production payload; it does not automatically retry POST requests. If OEIS
confirms a lower batch limit or idempotent upsert semantics, that is a separate
design change.

## Safety and Privacy

- Never call the transaction endpoint from this tool.
- Never create, update, or submit Company or Branch Master data.
- Never substitute identifiers from the earlier `37293`/`HIS_1104` invoice
  sample when an OEIS lookup fails.
- Never follow redirects; this prevents forwarding the API key to another host.
- Never retry POST automatically.
- Never print or persist request headers.
- Sanitize server error text before terminal output; retain the raw response
  only in the explicitly selected output directory.
- Create generated files with owner-only permissions where supported.
- Refuse an output directory equal to the repository root, user home, or `/`.
- Never mutate or overwrite the input CSV.
- Do not include patient or customer data; this catalog contains product data
  only.

## Repository Changes

Implementation creates only:

```text
scripts/oeis-product-upload/upload_products.py
scripts/oeis-product-upload/test_upload_products.py
scripts/oeis-product-upload/README.md
```

It also adds ignore rules for generated output under that folder. No runtime
JavaScript, invoice payload, database, Fynd route, or package dependency changes
are part of this feature.

The previously identified transaction discount-key mismatch is important but
belongs to a separate invoice-contract fix.

## Test Strategy

Tests use Python `unittest`, temporary directories, and a local in-process HTTP
server. They make no Fynd, OEIS, or internet requests.

Required behavior tests:

1. parse quoted multiline CSV and produce 300 rows;
2. map representative first, middle, and final products exactly;
3. preserve Arabic UTF-8 text and deterministic payload bytes/hash;
4. default exactly 29 blank tax percentages to 15 in local reports;
5. reject missing/duplicate/overlength identifiers and names;
6. reject missing Arabic script, mojibake, bidi controls, formula prefixes, and
   unexpected categorical/tax values;
7. prove `Verification Status`, tax percentage, and all unrelated columns are
   absent from the Product Master request;
8. prove default mode cannot make a network call;
9. prove execute mode requires HTTPS and environment-only credentials;
10. prove redirects and automatic retries are disabled;
11. validate full success, row failure, aggregate mismatch, unknown/duplicate
    response code, malformed JSON, timeout, and HTTP failure;
12. prove only accepted rows appear in the registry fragment and any partial
    failure exits nonzero.

## Acceptance Criteria

The feature is ready for controlled activation validation when:

- validation reports 300 products and 29 applied tax defaults;
- the generated request has exactly 300 Product Master objects and only seven
  allowlisted keys per object;
- every object uses `Viva Radix`, `Fynd`, `SA`, and `Service` exactly;
- no Company Master or Branch Master list or field appears in the request;
- all identifiers and bilingual descriptions match the source CSV exactly;
- dry-run/default execution performs no network request;
- the full isolated test suite and the repository test suite pass;
- no secret, output artifact, source catalog copy, or unrelated repository
  change is included in the implementation diff.

Production execution still requires an OEIS HTTPS production base URL, a
rotated API key, and successful pre-live confirmation of the exact endpoint,
authorization scheme, 300-record batch acceptance, response shape, and
duplicate/upsert behavior. It also requires operator confirmation that the
`Viva Radix`/`Fynd` Company Master is already registered in that exact target
environment.
