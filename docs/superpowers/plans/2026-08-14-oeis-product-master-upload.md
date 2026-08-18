# OEIS Product Master Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a standalone, product-only uploader that converts the translated 300-product Viva CSV into the OEIS `ProductMasterList` payload and submits it only after explicit operator opt-in.

**Architecture:** One Python 3 standard-library module owns CSV parsing, validation, deterministic JSON, safe output, optional HTTP submission, and response reconciliation. A colocated `unittest` suite exercises real CSV parsing, filesystem behavior, and a loopback HTTP server; the Node invoice runtime remains untouched.

**Tech Stack:** Python 3 standard library (`argparse`, `csv`, `dataclasses`, `hashlib`, `http.server`, `json`, `pathlib`, `tempfile`, `unittest`, `urllib`).

**Spec:** `docs/superpowers/specs/2026-08-13-oeis-product-master-upload-design.md`

## Global Constraints

- Generate only `ProductMasterList`; never generate Company, Branch, Customer, or Transaction lists.
- Use exactly `Viva Radix`, `Fynd`, `SA`, and `Service` in every product object.
- Map `Seller Identifier`, `Name`, and `Translated Product Name (Arabic)` without changing case or text.
- Treat exactly 29 blank tax percentages as 15 only in local reporting; never send tax in Product Master.
- Preserve source `Verification Status=pending`; never send it, `IsValidated`, or `ValidationError`.
- Default mode is offline. No test or completion verification may contact OEIS or Fynd.
- Require `--execute`, environment-only credentials, HTTPS by default, zero redirects, zero POST retries, and finite limits.
- Require a new unique output directory for every execute attempt; preserve and reject any prior execution artifact before configuration/network.
- Use Python standard library only. Do not change application dependencies.
- Do not modify source CSVs, runtime JavaScript, databases, invoice payloads, Docker files, or the root README.
- Do not stage or commit; the dirty worktree contains user-owned changes.

## File Structure

- Create `scripts/oeis-product-upload/upload_products.py` for production logic and CLI.
- Create `scripts/oeis-product-upload/test_upload_products.py` for all automated tests.
- Create `scripts/oeis-product-upload/README.md` for the operator runbook.
- Modify `.gitignore` only to ignore `scripts/oeis-product-upload/out/`.

---

### Task 1: CSV Contract, Validation, and Payload

**Files:**
- Create: `scripts/oeis-product-upload/upload_products.py`
- Create: `scripts/oeis-product-upload/test_upload_products.py`

**Interfaces:**
- Produces: `CatalogValidationError(errors: tuple[str, ...])`.
- Produces: `BuildResult(payload, payload_bytes, payload_sha256, source_sha256, defaulted_tax_codes)`.
- Produces: `load_catalog(path: pathlib.Path) -> list[tuple[int, dict[str, str]]]`.
- Produces: `build_product_master(path: pathlib.Path) -> BuildResult`.
- Produces: `canonical_json_bytes(value: object) -> bytes`.

- [x] **Step 1: Write the failing happy-path mapping test**

Create a test helper that writes 156 headers and 300 unique rows with embedded quoted newlines:

```python
REQUIRED_HEADERS = [
    "Seller Identifier", "Name", "Translated Product Name (Arabic)",
    "Product Type", "Verification Status", "Currency",
    "Country of Origin", "Tax Rule Name", "Tax percentage",
]

def write_catalog(path, mutate=None):
    headers = REQUIRED_HEADERS + [f"Unused {i:03d}" for i in range(147)]
    rows = []
    for index in range(300):
        row = {header: "" for header in headers}
        row.update({
            "Seller Identifier": f"SKU-{index + 1:03d}",
            "Name": f"Service {index + 1}",
            "Translated Product Name (Arabic)": f"خدمة {index + 1}",
            "Product Type": "service", "Verification Status": "pending",
            "Currency": "SAR", "Country of Origin": "Saudi Arabia",
            "Tax Rule Name": "Standard VAT (15%)",
            "Tax percentage": "" if index < 29 else "15",
            "Unused 000": "line one\nline two",
        })
        rows.append(row)
    if mutate:
        mutate(rows)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, dialect="excel")
        writer.writeheader()
        writer.writerows(rows)
```

Assert the first product equals this hand-derived literal and the output has 300 products, 29 defaults, UTF-8 Arabic, a trailing newline, and a correct SHA-256:

```python
{
    "COMPANY_CODE": "Viva Radix",
    "SOURCE_ERP": "Fynd",
    "SUPPLIER_COUNTRY_CODE_ENGLISH": "SA",
    "PRODUCT_CODE": "SKU-001",
    "PRODUCT_DESCRIPTION_1_ENGLISH": "Service 1",
    "PRODUCT_DESCRIPTION_1_LANG02": "خدمة 1",
    "PRODUCT_TYPE": "Service",
}
```

- [x] **Step 2: Run the mapping test and verify RED**

Run:

```sh
python3 -m unittest scripts/oeis-product-upload/test_upload_products.py \
  -k test_build_product_master_maps_all_300_rows_exactly -v
```

Expected: import or attribute failure because production code is absent.

- [x] **Step 3: Implement the minimal mapping path**

Define:

```python
COMPANY_CODE = "Viva Radix"
SOURCE_ERP = "Fynd"
COUNTRY_CODE = "SA"
PRODUCT_TYPE = "Service"
EXPECTED_ROWS = 300
EXPECTED_COLUMNS = 156
PRODUCT_KEYS = (
    "COMPANY_CODE", "SOURCE_ERP", "SUPPLIER_COUNTRY_CODE_ENGLISH",
    "PRODUCT_CODE", "PRODUCT_DESCRIPTION_1_ENGLISH",
    "PRODUCT_DESCRIPTION_1_LANG02", "PRODUCT_TYPE",
)

@dataclass(frozen=True)
class BuildResult:
    payload: dict[str, list[dict[str, str]]]
    payload_bytes: bytes
    payload_sha256: str
    source_sha256: str
    defaulted_tax_codes: tuple[str, ...]

def canonical_json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
```

Read the source bytes exactly once, hash that snapshot, and parse the same bytes with `io.BytesIO` plus `io.TextIOWrapper(encoding="utf-8-sig", newline="")` and `csv.DictReader(..., dialect="excel")`. Reject duplicate/missing headers and ragged rows. Retain logical rows starting at 2. Map only `PRODUCT_KEYS` in source order and hash exact source/payload bytes.

- [x] **Step 4: Run the mapping test and verify GREEN**

Run the Step 2 command. Expected: one passing test.

- [x] **Step 5: Write failing validation tests**

Add separate behavior tests for missing headers; row count/width; blank, duplicate, and overlength codes; blank/overlength names; missing Arabic script; replacement/null/bidi controls; `????`; formula prefixes; invalid type/status/currency/country/tax rule/tax percentage; and a blank-tax count other than 29.

Include these literal cases:

```python
def test_rejects_case_insensitive_duplicate_product_code(self):
    self.assert_catalog_error(
        lambda rows: rows[1].__setitem__("Seller Identifier", "sku-001"),
        "duplicate PRODUCT_CODE",
    )

def test_request_omits_server_owned_and_unrelated_fields(self):
    row = self.build_valid().payload["ProductMasterList"][0]
    self.assertEqual(tuple(row), upload_products.PRODUCT_KEYS)
    for key in ("Tax percentage", "Verification Status", "IsValidated", "ValidationError"):
        self.assertNotIn(key, row)
```

- [x] **Step 6: Run validation tests and verify RED**

Run the full Python test file. Expected: mapping passes and new validation cases fail.

- [x] **Step 7: Implement aggregate validation**

Use:

```python
ARABIC_RE = re.compile(r"[\u0600-\u06ff]")
BIDI_CONTROLS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")
LIMITS = {"PRODUCT_CODE": 50, "PRODUCT_DESCRIPTION_1_ENGLISH": 250,
          "PRODUCT_DESCRIPTION_1_LANG02": 500}
```

Aggregate safe errors with logical row and product code. Track case-folded codes. Record defaults only for blank tax values and require exactly 29. Unsafe mapped text contains replacement/null characters, `????`, bidi controls, or a trimmed prefix in `=+-@`.

- [x] **Step 8: Run Task 1 tests and verify GREEN**

Run the full Python test file. Expected: every Task 1 test passes.

---

### Task 2: Private Artifacts and Offline CLI

**Files:**
- Modify: `scripts/oeis-product-upload/upload_products.py`
- Modify: `scripts/oeis-product-upload/test_upload_products.py`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `build_validation_report(result) -> dict[str, object]`.
- Produces: `prepare_output_dir(path, repo_root) -> pathlib.Path`.
- Produces: `atomic_write_private(path, body) -> None`.
- Produces: `generate_offline_artifacts(result, output_dir) -> None`.
- Produces: `main(argv=None, environ=None) -> int`.

- [x] **Step 1: Write failing artifact and offline CLI tests**

Prove default execution writes valid payload/report without requiring any
`OEIS_*` network configuration, sets files to mode `0600`, rejects `/`,
`Path.home()`, and repository root as output directories, and writes no payload
for invalid input. Task 3 will add the direct `submit_payload` non-call
regression after that interface exists.

The report must equal the fixed schema:

```python
{
    "status": "valid", "source_sha256": result.source_sha256,
    "payload_sha256": result.payload_sha256, "product_count": 300,
    "defaulted_tax_count": 29,
    "defaulted_tax_product_codes": list(result.defaulted_tax_codes),
    "constants": {"COMPANY_CODE": "Viva Radix", "SOURCE_ERP": "Fynd",
                  "SUPPLIER_COUNTRY_CODE_ENGLISH": "SA", "PRODUCT_TYPE": "Service"},
}
```

- [x] **Step 2: Run Task 2 tests and verify RED**

Run the full Python test file. Expected: new tests fail because artifact/CLI functions are missing.

- [x] **Step 3: Implement private atomic output**

Resolve and validate the output path, create it with `0700`, write temporary files in the destination with `0600`, flush and `fsync`, replace atomically, and reapply `0600`. If `fchmod` fails before `fdopen` owns the temporary descriptor, explicitly close the descriptor and unlink the temp path. Write `product-master-payload.json` and `validation-report.json` only after successful validation; validation failure writes neither file.

- [x] **Step 4: Implement the offline CLI**

Add required `--input` and `--output-dir`, plus `--execute` and `--allow-insecure-http`. Default mode only builds/writes offline artifacts and prints counts/hashes. Return 1 with safe stderr on validation/config/output failure.

- [x] **Step 5: Add one scoped ignore rule**

Append without reformatting existing content:

```gitignore
# One-time OEIS Product Master uploader output
scripts/oeis-product-upload/out/
```

- [x] **Step 6: Run Task 2 tests and verify GREEN**

Run the full Python test file. Expected: all Task 1-2 tests pass.

---
### Task 3: Explicit HTTP Submission and Response Reconciliation

**Files:**
- Modify: `scripts/oeis-product-upload/upload_products.py`
- Modify: `scripts/oeis-product-upload/test_upload_products.py`

**Interfaces:**
- Produces: `HttpConfig(base_url, api_key, timeout_seconds, max_request_bytes, max_response_bytes)`.
- Produces: `load_http_config(environ, allow_insecure_http) -> HttpConfig`.
- Produces: `submit_payload(payload_bytes, config) -> tuple[int, bytes]`.
- Produces: `reconcile_response(payload, response_body) -> ReconcileResult`.
- Produces: `write_execution_artifacts(...) -> None`.

- [x] **Step 1: Write failing strict-configuration tests**

Cover missing base URL/key, leading/trailing whitespace or control characters in
either value, URL credentials/query/fragment/non-origin paths, invalid ports,
HTTP without explicit allowance, invalid timeout/size values, and request
overflow. Assert this literal valid configuration:

```python
config = upload_products.load_http_config({
    "OEIS_BASE_URL": "https://oeis.example.test",
    "OEIS_API_KEY": "secret-key",
    "OEIS_TIMEOUT_MS": "30000",
    "OEIS_MAX_REQUEST_BYTES": "4194304",
    "OEIS_MAX_RESPONSE_BYTES": "4194304",
}, allow_insecure_http=False)
self.assertEqual(config.base_url, "https://oeis.example.test")
self.assertEqual(config.timeout_seconds, 30.0)
```

- [x] **Step 2: Run configuration tests and verify RED**

Run the full Python test file. Expected: configuration tests fail because the interface is missing.

- [x] **Step 3: Implement strict HTTP configuration**

Use `urlsplit` to require a host, valid optional port, no
credentials/query/fragment, and path only empty or `/`. Reject whitespace,
controls, and unsafe API-key header content before constructing a request.
Allow HTTPS, or HTTP only with `--allow-insecure-http`. Default timeout/caps to
the values above and require positive integers. Define:

```python
PRODUCT_MASTER_PATH = "/API/InvoicingMasterAPI/UpdateData"
```

- [x] **Step 4: Write failing loopback HTTP tests**

Use a real `ThreadingHTTPServer` bound to `127.0.0.1`. Assert one POST uses the fixed path and exact headers/body:

```python
self.assertEqual(captured["authorization"], "APIkey secret-key")
self.assertEqual(captured["content_type"], "application/json; charset=utf-8")
self.assertEqual(captured["accept"], "application/json")
self.assertEqual(captured["body"], payload_bytes)
```

Add independent tests proving a 302 is not followed, HTTP 500 is attempted once, response overflow fails, and safe errors never contain the API key.

- [x] **Step 5: Run HTTP tests and verify RED**

Run the full Python test file. Expected: loopback tests fail because submission is missing.

- [x] **Step 6: Implement one-shot no-redirect submission**

Create an opener with a `HTTPRedirectHandler` whose `redirect_request` returns
`None` and disable environment proxy discovery for this explicit vendor
destination. Enforce the request cap before opening a connection. Create one
`urllib.request.Request` with method `POST`, accept only HTTP 2xx, read at most
`max_response_bytes + 1`, and map HTTP/URL/timeout/framing failures, including
`http.client.HTTPException`, to fixed safe
`UploadError` codes. Never include URLs, headers, response bodies, exception
messages, or credentials in terminal errors and never retry.

- [x] **Step 7: Write failing reconciliation tests**

Use a complete 300-row success response with each requested `PRODUCT_CODE`, `IsValidated=True`, and:

```python
"ProductMasterLogs": {
    "IsSystemException": False,
    "SystemException": {},
    "TotalRecordsCount": 300,
    "SuccessRecordCount": 300,
    "ErrorRecordCount": 0,
}
```

Add cases for invalid JSON, missing list/logs, unknown top-level fields, wrong
types (including booleans/numeric strings used as counts), nonempty/system
exception, negative or unreconciled counts, duplicate/unknown/missing code,
false/missing validation, and populated `ValidationError`.

The documented failed-row error is an object shaped as
`{"ErrorMessage": "..."}`; successful rows omit `ValidationError`. The vendor
does not guarantee response order, so tests must shuffle rows and still
reconcile by exact `PRODUCT_CODE`.

- [x] **Step 8: Run reconciliation tests and verify RED**

Run the full Python test file. Expected: response tests fail because reconciliation is missing.

- [x] **Step 9: Implement fail-closed reconciliation and execution artifacts**

Require a root object with `ProductMasterList` and `ProductMasterLogs`, exact
documented JSON types (`type(count) is int`, not boolean or numeric string),
nonnegative and reconciled aggregate counts, an empty documented
`SystemException` object, exact case-sensitive code reconciliation independent
of row order, zero aggregate errors, and all 300 rows validated. Permit only the
six documented sibling master list/log keys as harmless top-level compatibility
fields; reject unknown top-level fields and never let sibling status replace or
override the Product Master pair. A structurally valid partial response writes
accepted registry entries only for exact unique requested codes returned with
`IsValidated: true`; a malformed or ambiguous response writes no accepted
claims. Privately write exact `oeis-response.json`, a results CSV with only:

```text
PRODUCT_CODE,SOURCE_VERIFICATION_STATUS,OEIS_IS_VALIDATED,OEIS_ERROR
```

and `accepted-products-registry.json` with accepted codes mapped to
`{"uqc":"OTH","tax_category":"S","tax_rate":"15.00"}`. Neutralize CSV formula
prefixes and control characters in vendor error text, cap it to a small fixed
length, and never print it to the terminal. Any partial/malformed result exits
nonzero, while a complete 300/300 response returns success.

- [x] **Step 10: Wire `--execute` after offline generation**

First add a regression that patches `submit_payload` to fail if called and
proves default CLI execution never invokes it. Only when `--execute` is present:
reject any existing response, results, or accepted-registry artifact before
configuration/network without changing it; atomically establish an empty
accepted registry; load environment config; submit exact payload bytes once;
persist/reconcile; and return 0 only for full success. Existing offline
payload/report files alone are allowed. Preserve offline artifacts on every
failure, and require a new unique output directory for every execute attempt.

- [x] **Step 11: Run the full focused suite and verify GREEN**

Run:

```sh
python3 -m unittest discover -s scripts/oeis-product-upload -p 'test_*.py' -v
```

Expected: all tests pass with loopback-only networking.

---

### Task 4: Runbook and Real-Catalog Offline Verification

**Files:**
- Create: `scripts/oeis-product-upload/README.md`
- Verify: `scripts/oeis-product-upload/upload_products.py`
- Verify: `scripts/oeis-product-upload/test_upload_products.py`
- Verify: `.gitignore`

**Interfaces:**
- Produces: a safe runbook and offline artifacts under `scripts/oeis-product-upload/out/`.

- [x] **Step 1: Write the operator runbook**

Document product-only scope, translated CSV input, exact constants, offline and execute commands, non-echoing API-key entry, a new unique output directory for every execute attempt/retry, exact explicit HTTP transport opt-in, production HTTPS, no redirects/retries, unchanged pending source status, full-success criteria, and duplicate/upsert recovery. Include no real URL/IP, API key, VAT/TIN, bank, or customer data.

- [x] **Step 2: Run focused tests with fresh evidence**

Run the Task 3 Step 11 command. Expected: all tests pass.

- [x] **Step 3: Generate the real payload offline**

Run without `--execute`:

```sh
python3 scripts/oeis-product-upload/upload_products.py \
  --input "/Users/ayushmittal/Documents/ChatGPT/All Download related stuff/outputs/viva_full_details_20260813/Viva_300_products_full_details_with_arabic_names.csv" \
  --output-dir "/Users/ayushmittal/Documents/AppProducts/fyndExt/scripts/oeis-product-upload/out"
```

Expected: 300 products, 29 defaults, both hashes, and no network activity.

- [x] **Step 4: Verify artifacts independently**

Load payload/report in a separate read-only command and assert 300 rows, seven exact keys, exact constants, 300 case-insensitively unique codes, no server-owned fields, and source/payload SHA-256 equality with the report.

- [x] **Step 5: Run repository regressions**

Run:

```sh
npm test -- --runInBand
```

If the existing wrapper rejects the extra flag, run `npm test` exactly and report that result.

- [x] **Step 6: Review final scope**

Run:

```sh
git status --short
git diff --check
git diff -- .gitignore scripts/oeis-product-upload/ \
  docs/superpowers/specs/2026-08-13-oeis-product-master-upload-design.md \
  docs/superpowers/plans/2026-08-14-oeis-product-master-upload.md
```

Confirm no source CSV, credential, live response, unrelated file, or runtime change was introduced. Leave changes unstaged and uncommitted.
