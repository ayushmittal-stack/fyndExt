import argparse
import csv
import hashlib
import http.client
import ipaddress
import io
import json
import math
import os
import re
import socket
import sys
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    ProxyHandler,
    Request,
    build_opener,
)


COMPANY_CODE = "Viva Radix"
SOURCE_ERP = "Fynd"
COUNTRY_CODE = "SA"
PRODUCT_TYPE = "Service"
EXPECTED_ROWS = 300
EXPECTED_COLUMNS = 156
PRODUCT_MASTER_PATH = "/API/InvoicingMasterAPI/UpdateData"
DEFAULT_TIMEOUT_MS = 30000
DEFAULT_MAX_REQUEST_BYTES = 4194304
DEFAULT_MAX_RESPONSE_BYTES = 4194304
# One explicit 300-row upload may wait at most five minutes and exchange at
# most 16 MiB in either direction. These lexical bounds also prevent enormous
# environment integers from reaching int/float conversion.
MAX_TIMEOUT_MS = 300000
MAX_REQUEST_BYTES = 16777216
MAX_RESPONSE_BYTES = 16777216
MAX_RESULT_ERROR_CHARACTERS = 240
EXECUTION_ARTIFACT_NAMES = (
    "oeis-response.json",
    "oeis-product-results.csv",
    "accepted-products-registry.json",
)
RESPONSE_TOP_LEVEL_KEYS = frozenset({
    "ProductMasterList",
    "ProductMasterLogs",
    "CompanyMasterList",
    "CompanyMasterLogs",
    "CustomerMasterList",
    "CustomerMasterLogs",
    "BranchMasterList",
    "BranchMasterLogs",
})
PRODUCT_LOG_KEYS = frozenset({
    "IsSystemException",
    "SystemException",
    "TotalRecordsCount",
    "SuccessRecordCount",
    "ErrorRecordCount",
})
PRODUCT_KEYS = (
    "COMPANY_CODE", "SOURCE_ERP", "SUPPLIER_COUNTRY_CODE_ENGLISH",
    "PRODUCT_CODE", "PRODUCT_DESCRIPTION_1_ENGLISH",
    "PRODUCT_DESCRIPTION_1_LANG02", "PRODUCT_TYPE",
)
ARABIC_RE = re.compile(r"[\u0600-\u06ff]")
BIDI_CONTROLS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")
LIMITS = {
    "PRODUCT_CODE": 50,
    "PRODUCT_DESCRIPTION_1_ENGLISH": 250,
    "PRODUCT_DESCRIPTION_1_LANG02": 500,
}
REQUIRED_HEADERS = (
    "Seller Identifier",
    "Name",
    "Translated Product Name (Arabic)",
    "Product Type",
    "Verification Status",
    "Currency",
    "Country of Origin",
    "Tax Rule Name",
    "Tax percentage",
)


class CatalogValidationError(Exception):
    def __init__(self, errors: tuple[str, ...]):
        self.errors = errors
        super().__init__("\n".join(errors))


class UploadError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(f"upload failed ({code})")


@dataclass(frozen=True)
class BuildResult:
    payload: dict[str, list[dict[str, str]]]
    payload_bytes: bytes
    payload_sha256: str
    source_sha256: str
    defaulted_tax_codes: tuple[str, ...]
    full_catalog_product_count: int = EXPECTED_ROWS
    selection_mode: str = "all"
    selected_product_code: Optional[str] = None
    excluded_product_code: Optional[str] = None


@dataclass(frozen=True)
class HttpConfig:
    base_url: str
    api_key: str
    timeout_seconds: float
    max_request_bytes: int
    max_response_bytes: int


@dataclass(frozen=True)
class ReconcileRow:
    product_code: str
    is_validated: object
    error: str


@dataclass(frozen=True)
class ReconcileResult:
    is_complete: bool
    is_structurally_valid: bool
    rows: tuple[ReconcileRow, ...]
    accepted_codes: tuple[str, ...]
    error_code: str


def _has_control_characters(value: str) -> bool:
    return any(unicodedata.category(character).startswith("C") for character in value)


def _required_http_value(environ: object, name: str) -> str:
    getter = getattr(environ, "get", None)
    if getter is None:
        raise UploadError("invalid_http_config")
    value = getter(name)
    if not isinstance(value, str) or not value or value != value.strip():
        raise UploadError("invalid_http_config")
    if _has_control_characters(value):
        raise UploadError("invalid_http_config")
    return value


def _positive_integer_option(
    environ: object, name: str, default: int, maximum: int
) -> int:
    value = environ.get(name, str(default))
    if not isinstance(value, str) or re.fullmatch(r"[1-9][0-9]*", value) is None:
        raise UploadError("invalid_http_config")
    maximum_text = str(maximum)
    if len(value) > len(maximum_text) or (
        len(value) == len(maximum_text) and value > maximum_text
    ):
        raise UploadError("invalid_http_config")
    return int(value)


def _is_valid_http_hostname(hostname: str, netloc: str) -> bool:
    if netloc.startswith("["):
        try:
            ipaddress.IPv6Address(hostname)
        except ValueError:
            return False
        return True
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        return True
    if re.fullmatch(r"[0-9.]+", hostname):
        return False
    if len(hostname) > 253 or hostname.endswith("."):
        return False
    labels = hostname.split(".")
    return all(
        1 <= len(label) <= 63
        and re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", label)
        is not None
        for label in labels
    )


def load_http_config(environ, allow_insecure_http: bool) -> HttpConfig:
    base_url = _required_http_value(environ, "OEIS_BASE_URL")
    api_key = _required_http_value(environ, "OEIS_API_KEY")
    if any(character.isspace() or ord(character) > 0x7f for character in base_url):
        raise UploadError("invalid_http_config")
    if any(ord(character) < 0x20 or ord(character) > 0x7e for character in api_key):
        raise UploadError("invalid_http_config")
    try:
        parsed = urlsplit(base_url)
        port = parsed.port
        hostname = parsed.hostname
    except ValueError:
        parsed = None
        port = None
        hostname = None
    if parsed is None:
        raise UploadError("invalid_http_config") from None
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.netloc
        or hostname is None
        or not _is_valid_http_hostname(hostname, parsed.netloc)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or "?" in base_url
        or "#" in base_url
        or parsed.netloc.endswith(":")
        or port == 0
    ):
        raise UploadError("invalid_http_config")
    if parsed.scheme == "http" and not allow_insecure_http:
        raise UploadError("insecure_http_disallowed")
    timeout_ms = _positive_integer_option(
        environ, "OEIS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS
    )
    max_request_bytes = _positive_integer_option(
        environ,
        "OEIS_MAX_REQUEST_BYTES",
        DEFAULT_MAX_REQUEST_BYTES,
        MAX_REQUEST_BYTES,
    )
    max_response_bytes = _positive_integer_option(
        environ,
        "OEIS_MAX_RESPONSE_BYTES",
        DEFAULT_MAX_RESPONSE_BYTES,
        MAX_RESPONSE_BYTES,
    )
    return HttpConfig(
        base_url=f"{parsed.scheme}://{parsed.netloc}",
        api_key=api_key,
        timeout_seconds=timeout_ms / 1000.0,
        max_request_bytes=max_request_bytes,
        max_response_bytes=max_response_bytes,
    )


def submit_payload(payload_bytes: bytes, config: HttpConfig) -> tuple[int, bytes]:
    if len(payload_bytes) > config.max_request_bytes:
        raise UploadError("request_too_large")

    class NoRedirectHandler(HTTPRedirectHandler):
        def redirect_request(self, request, file_pointer, code, message, headers, new_url):
            return None

    failure_code = ""
    try:
        request = Request(
            config.base_url + PRODUCT_MASTER_PATH,
            data=payload_bytes,
            headers={
                "Authorization": f"APIkey {config.api_key}",
                "Content-Type": "application/json; charset=utf-8",
                "Accept": "application/json",
            },
            method="POST",
        )
        opener = build_opener(ProxyHandler({}), NoRedirectHandler())
        with opener.open(request, timeout=config.timeout_seconds) as response:
            status = response.getcode()
            if not 200 <= status <= 299:
                failure_code = "http_status"
                response_body = b""
            else:
                response_body = response.read(config.max_response_bytes + 1)
    except HTTPError as error:
        error.close()
        failure_code = "http_status"
    except (TimeoutError, socket.timeout):
        failure_code = "timeout"
    except (URLError, OSError):
        failure_code = "network_error"
    except (http.client.InvalidURL, UnicodeError, ValueError):
        failure_code = "invalid_http_config"
    except http.client.HTTPException:
        failure_code = "network_error"
    if failure_code:
        raise UploadError(failure_code) from None
    if len(response_body) > config.max_response_bytes:
        raise UploadError("response_too_large")
    return status, response_body


def _requested_product_codes(payload: object) -> tuple[str, ...]:
    if type(payload) is not dict or set(payload) != {"ProductMasterList"}:
        return ()
    products = payload.get("ProductMasterList")
    if type(products) is not list:
        return ()
    codes = []
    seen = set()
    for product in products:
        if type(product) is not dict:
            return ()
        code = product.get("PRODUCT_CODE")
        if type(code) is not str or not code or code in seen:
            return ()
        seen.add(code)
        codes.append(code)
    return tuple(codes)


def _malformed_reconcile_result(codes: tuple[str, ...]) -> ReconcileResult:
    return ReconcileResult(
        is_complete=False,
        is_structurally_valid=False,
        rows=tuple(ReconcileRow(code, None, "") for code in codes),
        accepted_codes=(),
        error_code="malformed_response",
    )


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _reject_json_constant(_value):
    raise ValueError("non-standard JSON constant")


def reconcile_response(payload, response_body: bytes) -> ReconcileResult:
    requested_codes = _requested_product_codes(payload)
    malformed = lambda: _malformed_reconcile_result(requested_codes)
    if (
        not 1 <= len(requested_codes) <= EXPECTED_ROWS
        or not isinstance(response_body, bytes)
    ):
        return malformed()
    try:
        response = json.loads(
            response_body.decode("utf-8"),
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
        return malformed()
    if type(response) is not dict:
        return malformed()
    if not {"ProductMasterList", "ProductMasterLogs"}.issubset(response):
        return malformed()
    if not set(response).issubset(RESPONSE_TOP_LEVEL_KEYS):
        return malformed()

    response_rows = response["ProductMasterList"]
    logs = response["ProductMasterLogs"]
    if type(response_rows) is not list or type(logs) is not dict:
        return malformed()
    if set(logs) != PRODUCT_LOG_KEYS:
        return malformed()
    if type(logs["IsSystemException"]) is not bool:
        return malformed()
    if logs["IsSystemException"] is not False:
        return malformed()
    if type(logs["SystemException"]) is not dict or logs["SystemException"]:
        return malformed()

    count_names = (
        "TotalRecordsCount", "SuccessRecordCount", "ErrorRecordCount"
    )
    if any(
        type(logs[name]) not in (int, float)
        or (
            type(logs[name]) is float
            and (not math.isfinite(logs[name]) or not logs[name].is_integer())
        )
        for name in count_names
    ):
        return malformed()
    total_count, success_count, error_count = (
        int(logs[name]) for name in count_names
    )
    if min(total_count, success_count, error_count) < 0:
        return malformed()
    if (
        total_count != len(requested_codes)
        or total_count != len(response_rows)
        or success_count + error_count != total_count
    ):
        return malformed()

    by_code = {}
    for response_row in response_rows:
        if type(response_row) is not dict:
            return malformed()
        code = response_row.get("PRODUCT_CODE")
        is_validated = response_row.get("IsValidated")
        if type(code) is not str or type(is_validated) is not bool:
            return malformed()
        if code in by_code:
            return malformed()
        if is_validated:
            if "ValidationError" in response_row:
                return malformed()
            error_message = ""
        else:
            validation_error = response_row.get("ValidationError")
            if (
                type(validation_error) is not dict
                or set(validation_error) != {"ErrorMessage"}
                or type(validation_error.get("ErrorMessage")) is not str
            ):
                return malformed()
            error_message = validation_error["ErrorMessage"]
        by_code[code] = (is_validated, error_message)
    if set(by_code) != set(requested_codes):
        return malformed()

    actual_successes = sum(
        1 for is_validated, _ in by_code.values() if is_validated
    )
    if actual_successes != success_count:
        return malformed()
    if len(by_code) - actual_successes != error_count:
        return malformed()
    rows = tuple(
        ReconcileRow(code, by_code[code][0], by_code[code][1])
        for code in requested_codes
    )
    accepted_codes = tuple(
        row.product_code for row in rows if row.is_validated is True
    )
    is_complete = error_count == 0 and success_count == len(requested_codes)
    return ReconcileResult(
        is_complete=is_complete,
        is_structurally_valid=True,
        rows=rows,
        accepted_codes=accepted_codes,
        error_code="" if is_complete else "partial_failure",
    )


def _safe_csv_error(value: str) -> str:
    sanitized = "".join(
        " " if unicodedata.category(character).startswith("C") else character
        for character in value
    )
    if sanitized.lstrip().startswith(("=", "+", "-", "@")):
        sanitized = "'" + sanitized
    return sanitized[:MAX_RESULT_ERROR_CHARACTERS]


def _accepted_registry_bytes(codes) -> bytes:
    registry = {
        "products": {
            code: {"uqc": "OTH", "tax_category": "S", "tax_rate": "15.00"}
            for code in codes
        }
    }
    return canonical_json_bytes(registry)


def initialize_execution_artifacts(output_dir: Path) -> None:
    destination = Path(output_dir)
    stale_artifacts = any(
        os.path.lexists(destination / name) for name in EXECUTION_ARTIFACT_NAMES
    )
    if not stale_artifacts:
        try:
            atomic_write_private(
                destination / "accepted-products-registry.json",
                _accepted_registry_bytes(()),
                replace_existing=False,
            )
        except FileExistsError:
            stale_artifacts = True
    if stale_artifacts:
        raise UploadError("stale_execution_artifacts") from None


def write_execution_artifacts(
    output_dir: Path, response_body: bytes, result: ReconcileResult
) -> None:
    destination = Path(output_dir)
    atomic_write_private(destination / "oeis-response.json", response_body)

    csv_buffer = io.StringIO(newline="")
    writer = csv.writer(csv_buffer, lineterminator="\n")
    writer.writerow((
        "PRODUCT_CODE",
        "SOURCE_VERIFICATION_STATUS",
        "OEIS_IS_VALIDATED",
        "OEIS_ERROR",
    ))
    for row in result.rows:
        if row.is_validated is True:
            validated = "true"
        elif row.is_validated is False:
            validated = "false"
        else:
            validated = ""
        writer.writerow((
            row.product_code,
            "pending",
            validated,
            _safe_csv_error(row.error),
        ))
    atomic_write_private(
        destination / "oeis-product-results.csv",
        csv_buffer.getvalue().encode("utf-8"),
    )

    accepted_codes = result.accepted_codes if result.is_structurally_valid else ()
    atomic_write_private(
        destination / "accepted-products-registry.json",
        _accepted_registry_bytes(accepted_codes),
    )


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _parse_catalog_bytes(source_bytes: bytes) -> list[tuple[int, dict[str, str]]]:
    with io.TextIOWrapper(
        io.BytesIO(source_bytes), encoding="utf-8-sig", newline=""
    ) as handle:
        reader = csv.DictReader(handle, dialect="excel")
        headers = reader.fieldnames
        errors = []
        if headers is None:
            errors.append("CSV header row is missing")
        else:
            duplicates = sorted({header for header in headers if headers.count(header) > 1})
            if duplicates:
                errors.append(f"duplicate headers: {', '.join(duplicates)}")
            missing = [header for header in REQUIRED_HEADERS if header not in headers]
            if missing:
                errors.append(f"missing headers: {', '.join(missing)}")
            if len(headers) != EXPECTED_COLUMNS:
                errors.append(
                    f"header width must be {EXPECTED_COLUMNS}, got {len(headers)}"
                )
        if errors:
            raise CatalogValidationError(tuple(errors))

        rows = []
        try:
            for logical_row, row in enumerate(reader, start=2):
                if None in row or any(value is None for value in row.values()):
                    errors.append(
                        f"row {logical_row}: must contain {EXPECTED_COLUMNS} fields"
                    )
                    continue
                if len(row) != EXPECTED_COLUMNS:
                    errors.append(
                        f"row {logical_row}: must contain {EXPECTED_COLUMNS} fields"
                    )
                    continue
                rows.append((logical_row, row))
        except csv.Error as error:
            errors.append(f"unsafe CSV input: {error}")
        if errors:
            raise CatalogValidationError(tuple(errors))
    return rows


def load_catalog(path: Path) -> list[tuple[int, dict[str, str]]]:
    return _parse_catalog_bytes(Path(path).read_bytes())


def _is_unsafe(value: str) -> bool:
    return (
        "\ufffd" in value
        or "\x00" in value
        or "????" in value
        or any(control in value for control in BIDI_CONTROLS)
        or value.strip().startswith(("=", "+", "-", "@"))
    )


def _display_code(code: str) -> str:
    return code if code and not _is_unsafe(code) else "<unavailable>"


def _row_error(logical_row: int, code: str, message: str) -> str:
    return f"row {logical_row} ({_display_code(code)}): {message}"


def build_product_master(path: Path) -> BuildResult:
    source_bytes = Path(path).read_bytes()
    rows = _parse_catalog_bytes(source_bytes)
    errors = []
    products = []
    defaulted_tax_codes = []
    seen_codes = set()
    for logical_row, row in rows:
        code = row["Seller Identifier"]
        english_name = row["Name"]
        arabic_name = row["Translated Product Name (Arabic)"]
        mapped_values = {
            "PRODUCT_CODE": code,
            "PRODUCT_DESCRIPTION_1_ENGLISH": english_name,
            "PRODUCT_DESCRIPTION_1_LANG02": arabic_name,
        }
        for key, value in mapped_values.items():
            if _is_unsafe(value):
                errors.append(_row_error(logical_row, code, f"unsafe {key}"))
            if len(value) > LIMITS[key]:
                errors.append(
                    _row_error(logical_row, code, f"{key} exceeds {LIMITS[key]}")
                )

        if not code.strip():
            errors.append(_row_error(logical_row, code, "required PRODUCT_CODE"))
        elif code.casefold() in seen_codes:
            errors.append(_row_error(logical_row, code, "duplicate PRODUCT_CODE"))
        else:
            seen_codes.add(code.casefold())
        if not english_name.strip():
            errors.append(
                _row_error(logical_row, code, "required PRODUCT_DESCRIPTION_1_ENGLISH")
            )
        if not arabic_name.strip():
            errors.append(
                _row_error(logical_row, code, "required PRODUCT_DESCRIPTION_1_LANG02")
            )
        elif not ARABIC_RE.search(arabic_name):
            errors.append(
                _row_error(
                    logical_row,
                    code,
                    "PRODUCT_DESCRIPTION_1_LANG02 must contain Arabic script",
                )
            )

        expected_values = (
            ("Product Type", "service", True),
            ("Verification Status", "pending", False),
            ("Currency", "SAR", False),
            ("Country of Origin", "Saudi Arabia", False),
            ("Tax Rule Name", "Standard VAT (15%)", False),
        )
        for header, expected, case_insensitive in expected_values:
            value = row[header]
            valid = value.casefold() == expected.casefold() if case_insensitive else value == expected
            if not valid:
                errors.append(_row_error(logical_row, code, f"invalid {header}"))

        if row["Tax percentage"] == "":
            defaulted_tax_codes.append(code)
        elif row["Tax percentage"] != "15":
            errors.append(_row_error(logical_row, code, "invalid Tax percentage"))
        products.append({
            "COMPANY_CODE": COMPANY_CODE,
            "SOURCE_ERP": SOURCE_ERP,
            "SUPPLIER_COUNTRY_CODE_ENGLISH": COUNTRY_CODE,
            "PRODUCT_CODE": code,
            "PRODUCT_DESCRIPTION_1_ENGLISH": english_name,
            "PRODUCT_DESCRIPTION_1_LANG02": arabic_name,
            "PRODUCT_TYPE": PRODUCT_TYPE,
        })
    if len(rows) != EXPECTED_ROWS:
        errors.append(f"row count must be {EXPECTED_ROWS}, got {len(rows)}")
    if len(defaulted_tax_codes) != 29:
        errors.append(
            "exactly 29 blank Tax percentage values are required, "
            f"got {len(defaulted_tax_codes)}"
        )
    if errors:
        raise CatalogValidationError(tuple(errors))
    payload = {"ProductMasterList": products}
    payload_bytes = canonical_json_bytes(payload)
    return BuildResult(
        payload=payload,
        payload_bytes=payload_bytes,
        payload_sha256=hashlib.sha256(payload_bytes).hexdigest(),
        source_sha256=hashlib.sha256(source_bytes).hexdigest(),
        defaulted_tax_codes=tuple(defaulted_tax_codes),
        full_catalog_product_count=len(products),
    )


def select_product_request(
    result: BuildResult,
    *,
    smoke_product_code: Optional[str] = None,
    exclude_product_code: Optional[str] = None,
) -> BuildResult:
    if smoke_product_code is not None and exclude_product_code is not None:
        raise ValueError("product selection options are mutually exclusive")
    if smoke_product_code is None and exclude_product_code is None:
        return result

    selected_value = (
        smoke_product_code
        if smoke_product_code is not None
        else exclude_product_code
    )
    if not isinstance(selected_value, str) or not selected_value.strip():
        raise ValueError("PRODUCT_CODE selection must not be blank")

    products = result.payload["ProductMasterList"]
    if not any(product["PRODUCT_CODE"] == selected_value for product in products):
        raise ValueError("unknown PRODUCT_CODE selection")

    if smoke_product_code is not None:
        request_products = [
            product for product in products
            if product["PRODUCT_CODE"] == smoke_product_code
        ]
        selection_mode = "smoke_product_code"
    else:
        request_products = [
            product for product in products
            if product["PRODUCT_CODE"] != exclude_product_code
        ]
        selection_mode = "exclude_product_code"

    payload = {"ProductMasterList": request_products}
    payload_bytes = canonical_json_bytes(payload)
    return BuildResult(
        payload=payload,
        payload_bytes=payload_bytes,
        payload_sha256=hashlib.sha256(payload_bytes).hexdigest(),
        source_sha256=result.source_sha256,
        defaulted_tax_codes=result.defaulted_tax_codes,
        full_catalog_product_count=result.full_catalog_product_count,
        selection_mode=selection_mode,
        selected_product_code=smoke_product_code,
        excluded_product_code=exclude_product_code,
    )


def build_validation_report(result: BuildResult) -> dict[str, object]:
    request_product_count = len(result.payload["ProductMasterList"])
    return {
        "status": "valid",
        "source_sha256": result.source_sha256,
        "payload_sha256": result.payload_sha256,
        "product_count": request_product_count,
        "full_catalog_product_count": result.full_catalog_product_count,
        "request_product_count": request_product_count,
        "selection_mode": result.selection_mode,
        "selected_product_code": result.selected_product_code,
        "excluded_product_code": result.excluded_product_code,
        "defaulted_tax_count": len(result.defaulted_tax_codes),
        "defaulted_tax_product_codes": list(result.defaulted_tax_codes),
        "constants": {
            "COMPANY_CODE": COMPANY_CODE,
            "SOURCE_ERP": SOURCE_ERP,
            "SUPPLIER_COUNTRY_CODE_ENGLISH": COUNTRY_CODE,
            "PRODUCT_TYPE": PRODUCT_TYPE,
        },
    }


def prepare_output_dir(path: Path, repo_root: Path) -> Path:
    output_dir = Path(path).expanduser().resolve()
    protected_paths = {
        Path("/").resolve(),
        Path.home().resolve(),
        Path(repo_root).expanduser().resolve(),
    }
    if output_dir in protected_paths:
        raise ValueError("output directory must not be a protected directory")
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(output_dir, 0o700)
    return output_dir


def atomic_write_private(
    path: Path, body: bytes, *, replace_existing: bool = True
) -> None:
    destination = Path(path)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent
    )
    descriptor_open = True
    try:
        os.fchmod(file_descriptor, 0o600)
        handle = os.fdopen(file_descriptor, "wb")
        descriptor_open = False
        with handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        if replace_existing:
            os.replace(temporary_name, destination)
        else:
            os.link(temporary_name, destination)
            os.unlink(temporary_name)
        os.chmod(destination, 0o600)
    except BaseException:
        if descriptor_open:
            try:
                os.close(file_descriptor)
            except OSError:
                pass
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def generate_offline_artifacts(result: BuildResult, output_dir: Path) -> None:
    destination = Path(output_dir)
    atomic_write_private(destination / "product-master-payload.json", result.payload_bytes)
    atomic_write_private(
        destination / "validation-report.json",
        canonical_json_bytes(build_validation_report(result)),
    )


def main(argv=None, environ=None) -> int:
    parser = argparse.ArgumentParser(
        description="Build OEIS Product Master offline artifacts."
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--smoke-product-code")
    selection.add_argument("--exclude-product-code")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--allow-insecure-http", action="store_true")
    try:
        arguments = parser.parse_args(argv)
    except SystemExit as error:
        return 0 if error.code == 0 else 1

    try:
        full_catalog_result = build_product_master(arguments.input)
        result = select_product_request(
            full_catalog_result,
            smoke_product_code=arguments.smoke_product_code,
            exclude_product_code=arguments.exclude_product_code,
        )
        output_dir = prepare_output_dir(arguments.output_dir, Path(__file__).parents[2])
    except CatalogValidationError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    if arguments.execute:
        try:
            initialize_execution_artifacts(output_dir)
        except UploadError as error:
            print(f"error: {error}", file=sys.stderr)
            return 1
        except OSError:
            print("error: upload failed (execution_artifact_error)", file=sys.stderr)
            return 1

    try:
        generate_offline_artifacts(result, output_dir)
    except OSError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    if arguments.execute:
        try:
            config = load_http_config(
                os.environ if environ is None else environ,
                allow_insecure_http=arguments.allow_insecure_http,
            )
            _, response_body = submit_payload(result.payload_bytes, config)
            reconciliation = reconcile_response(result.payload, response_body)
            write_execution_artifacts(output_dir, response_body, reconciliation)
        except UploadError as error:
            print(f"error: {error}", file=sys.stderr)
            return 1
        except OSError:
            print("error: upload failed (execution_artifact_error)", file=sys.stderr)
            return 1
        if not reconciliation.is_complete:
            print(
                f"error: upload failed ({reconciliation.error_code})",
                file=sys.stderr,
            )
            return 1

    print(f"product_count={len(result.payload['ProductMasterList'])}")
    print(f"source_sha256={result.source_sha256}")
    print(f"payload_sha256={result.payload_sha256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
