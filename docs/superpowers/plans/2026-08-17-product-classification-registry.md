# OEIS Product Classification Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive a tax-neutral runtime master from the 300 already accepted OEIS product codes without re-uploading or mutating any OEIS Product Master record.

**Architecture:** A small Python standard-library converter reads the immutable cumulative accepted-product registry plus the approved Branch Master CSV and writes a new deterministic `oeis-masters.json`. The JavaScript master-data gateway accepts product classification metadata and no longer treats a product record as a fixed `S/15` tax result.

**Tech Stack:** Python 3 standard library, Node.js 24+, CommonJS, Jest 29.

**Spec:** `docs/superpowers/specs/2026-08-17-conditional-healthcare-vat-design.md`

## Global Constraints

- Do not call OEIS, Fynd, ZATCA, Kubernetes, or any external network endpoint.
- Do not overwrite any file under an existing `out/k8s-m3-runs/` execution directory.
- Do not modify the 300 Product Master records already accepted by OEIS.
- Preserve the same 300 `PRODUCT_CODE` values and `uqc=OTH`.
- Store product classification, not a final transaction tax category or rate.
- Classify the current 300 records only as `PRIVATE_HEALTHCARE_SERVICE` with allowed reason `VATEX-SA-HEA`.
- Do not introduce `VATEX-SA-35`; no qualifying goods classification has been approved.
- Require Branch Master identity values `Viva Radix`, `Fynd`, and `SA` and exactly the four approved branch codes `DAMSGH`, `JEDSGH`, `E014`, and `MD101`.
- Write new files with mode `0600`, directories with `0700`, deterministic UTF-8 JSON, and no silent overwrite.
- Do not stage or commit; the worktree contains user-owned changes.

## File Structure

- Create `scripts/oeis-product-upload/build_runtime_master.py` for offline conversion and validation.
- Create `scripts/oeis-product-upload/test_build_runtime_master.py` for Python unit and CLI tests.
- Modify `scripts/oeis-product-upload/README.md` with the offline conversion runbook.

---

### Task 1: Offline Runtime-Master Converter

**Files:**
- Create: `scripts/oeis-product-upload/build_runtime_master.py`
- Create: `scripts/oeis-product-upload/test_build_runtime_master.py`

**Interfaces:**
- Produces: `RegistryValidationError(errors: tuple[str, ...])`.
- Produces: `build_runtime_master(accepted_registry: pathlib.Path, branch_master: pathlib.Path) -> BuildResult`.
- Produces: `canonical_json_bytes(value: object) -> bytes`.
- Produces: CLI arguments `--accepted-registry`, `--branch-master`, and `--output`.

- [ ] **Step 1: Write the failing exact-conversion test**

Create a 300-product accepted-registry fixture using the historic schema and a
four-row Branch Master fixture. Assert the first product and branches equal:

```python
{
    "branches": ["DAMSGH", "JEDSGH", "E014", "MD101"],
    "products": {
        "FMDIF-001": {
            "uqc": "OTH",
            "supply_class": "PRIVATE_HEALTHCARE_SERVICE",
            "allowed_zero_rate_reason": "VATEX-SA-HEA",
        },
    },
}
```

Also assert that neither `tax_category` nor `tax_rate` appears in output bytes.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
python3 -m unittest scripts/oeis-product-upload/test_build_runtime_master.py \
  -k test_builds_exact_tax_neutral_runtime_master -v
```

Expected: import failure because `build_runtime_master.py` does not exist.

- [ ] **Step 3: Implement strict input parsing and deterministic mapping**

The accepted input must be a top-level object with only `products`; it must
contain exactly 300 unique nonblank product codes. Each historic value must
contain exactly `uqc`, `tax_category`, and `tax_rate`, with `OTH`, `S`, and
`15.00` respectively. Treat the tax values only as validation of the known
historic artifact; never copy them to the new output.

The Branch Master must contain exactly four rows and the required headers. Each
row must have `COMPANY_CODE=Viva Radix`, `SOURCE_ERP=Fynd`,
`SUPPLIER_COUNTRY_CODE_ENGLISH=SA`, a unique nonblank `BRANCH_CODE`, and the
exact four-code set.

Return a frozen dataclass containing the new value, exact JSON bytes, both input
SHA-256 values, and the output SHA-256.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Add failing validation and filesystem tests**

Cover malformed JSON, duplicate JSON keys, unknown product properties, wrong
historic tax values, wrong product count, invalid product code, missing/wrong
branch identity, duplicate/missing/extra branch code, output collision, unsafe
output directory, mode `0600`, deterministic bytes, and atomic write failure.

- [ ] **Step 6: Run the Python suite and verify RED**

Run:

```sh
python3 -m unittest scripts/oeis-product-upload/test_build_runtime_master.py -v
```

Expected: new validation/filesystem tests fail.

- [ ] **Step 7: Implement validation and offline-only CLI**

Use only Python standard-library modules. Write the output through a private
temporary file in the destination, flush, `fsync`, set `0600`, and create the
final path without replacing an existing file. Print only counts and hashes;
never print the registry body.

- [ ] **Step 8: Run the Python suite and verify GREEN**

Run the Step 6 command. Expected: all tests pass.

---

### Task 2: Documentation and Real Offline Artifact

**Files:**
- Modify: `scripts/oeis-product-upload/README.md`
- Generate outside the source tree or under the existing ignored `out/` path:
  a new uniquely named `oeis-masters.json` plus a hash report.

**Interfaces:**
- Consumes the immutable cumulative 300-product registry and the approved
  Branch Master CSV.
- Produces one candidate runtime master for review; it does not deploy it.

- [ ] **Step 1: Document the exact command**

Use the actual source paths:

```sh
python3 scripts/oeis-product-upload/build_runtime_master.py \
  --accepted-registry "scripts/oeis-product-upload/out/k8s-m3-runs/bulk-299-excluding-FMDIF-001-q7xn8p9w/cumulative-accepted-products-registry.json" \
  --branch-master "/Users/ayushmittal/Downloads/B1_BranchMaster_SGH_Stores_Fixed_BranchType (15 Jun) (1).csv" \
  --output "scripts/oeis-product-upload/out/conditional-vat-runtime-master/oeis-masters.json"
```

- [ ] **Step 2: Generate the artifact offline**

Run the documented command from the repository root. Expected: 300 products,
four branches, no tax category/rate fields, no network connection, and a newly
created private output.

- [ ] **Step 3: Independently verify the artifact**

Run:

```sh
python3 -m json.tool \
  scripts/oeis-product-upload/out/conditional-vat-runtime-master/oeis-masters.json \
  >/dev/null
rg -n 'tax_category|tax_rate' \
  scripts/oeis-product-upload/out/conditional-vat-runtime-master/oeis-masters.json
```

Expected: JSON validation exits 0 and `rg` exits 1 with no matches.

- [ ] **Step 4: Run all product-registry tests**

Run:

```sh
python3 -m unittest scripts/oeis-product-upload/test_build_runtime_master.py -v
```

Expected: all converter tests pass. Loading this candidate into the JavaScript
runtime is intentionally deferred to the conditional-invoicing plan so this
offline product-registry deliverable remains independently testable.
