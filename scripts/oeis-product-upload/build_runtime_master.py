"""Build a tax-neutral OEIS runtime product classification registry offline."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path


APPROVED_BRANCHES = ("DAMSGH", "JEDSGH", "E014", "MD101")
REQUIRED_BRANCH_HEADERS = {
    "COMPANY_CODE",
    "SOURCE_ERP",
    "SUPPLIER_COUNTRY_CODE_ENGLISH",
    "BRANCH_CODE",
}
HISTORIC_PRODUCT_PROPERTIES = {"uqc", "tax_category", "tax_rate"}
RESERVED_PRODUCT_CODES = {"__proto__", "constructor", "prototype"}


class RegistryValidationError(ValueError):
    def __init__(self, errors: tuple[str, ...]):
        self.errors = errors
        super().__init__("; ".join(errors))


class _DuplicateJsonKeyError(ValueError):
    pass


@dataclass(frozen=True)
class BuildResult:
    value: dict
    json_bytes: bytes
    accepted_registry_sha256: str
    branch_master_sha256: str
    product_code_set_sha256: str
    output_sha256: str


def canonical_json_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def product_code_set_sha256(product_codes: list[str]) -> str:
    hash_input = json.dumps(
        sorted(product_codes), ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(hash_input).hexdigest()


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKeyError(key)
        result[key] = value
    return result


def _read_accepted_registry(path: Path) -> tuple[object, bytes]:
    try:
        contents = path.read_bytes()
        return json.loads(contents.decode("utf-8"), object_pairs_hook=_unique_object), contents
    except _DuplicateJsonKeyError:
        raise RegistryValidationError(("accepted registry contains a duplicate JSON key",)) from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise RegistryValidationError(("accepted registry must be valid JSON",)) from None


def _read_branch_master(path: Path) -> tuple[list[dict[str, str | None]], bytes, list[str] | None]:
    try:
        contents = path.read_bytes()
        text = contents.decode("utf-8-sig")
        headers = next(csv.reader(io.StringIO(text)), None)
        if headers and any(headers.count(header) > 1 for header in REQUIRED_BRANCH_HEADERS):
            raise RegistryValidationError(("branch master contains a duplicate required header",))
        reader = csv.DictReader(io.StringIO(text))
        return list(reader), contents, reader.fieldnames
    except RegistryValidationError:
        raise
    except (OSError, UnicodeDecodeError, csv.Error):
        raise RegistryValidationError(("branch master must be valid UTF-8 CSV",)) from None


def _validate_accepted_registry(accepted: object) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    if type(accepted) is not dict or set(accepted) != {"products"} or type(accepted.get("products")) is not dict:
        return [], ["accepted registry must be a top-level object containing only products"]

    products = accepted["products"]
    if len(products) != 300:
        errors.append("accepted registry must contain exactly 300 products")

    codes: list[str] = []
    for code, historic_product in products.items():
        if (
            not isinstance(code, str)
            or not code.strip()
            or code in RESERVED_PRODUCT_CODES
        ):
            errors.append("accepted registry contains an invalid product code")
            continue
        codes.append(code)
        if type(historic_product) is not dict or set(historic_product) != HISTORIC_PRODUCT_PROPERTIES:
            errors.append("accepted registry product has unapproved properties")
            continue
        if (
            historic_product["uqc"] != "OTH"
            or historic_product["tax_category"] != "S"
            or historic_product["tax_rate"] != "15.00"
        ):
            errors.append("accepted registry product has invalid historic tax values")
    return codes, errors


def _validate_branch_master(rows: list[dict[str, str | None]], headers: list[str] | None) -> list[str]:
    errors: list[str] = []
    if not headers or not REQUIRED_BRANCH_HEADERS.issubset(headers):
        return ["branch master is missing required headers"]
    if len(rows) != 4:
        errors.append("branch master must contain exactly four rows")

    branch_codes: list[str] = []
    for row in rows:
        if (
            row.get("COMPANY_CODE") != "Viva Radix"
            or row.get("SOURCE_ERP") != "Fynd"
            or row.get("SUPPLIER_COUNTRY_CODE_ENGLISH") != "SA"
        ):
            errors.append("branch master has an invalid identity")
        code = row.get("BRANCH_CODE")
        if not isinstance(code, str) or not code.strip():
            errors.append("branch master has an invalid branch code")
            continue
        branch_codes.append(code)
    if len(branch_codes) != len(set(branch_codes)):
        errors.append("branch master has a duplicate branch code")
    if set(branch_codes) != set(APPROVED_BRANCHES):
        errors.append("branch master must contain the approved branch codes")
    return errors


def build_runtime_master(accepted_registry: Path, branch_master: Path) -> BuildResult:
    accepted, accepted_bytes = _read_accepted_registry(Path(accepted_registry))
    branch_rows, branch_bytes, branch_headers = _read_branch_master(Path(branch_master))
    product_codes, errors = _validate_accepted_registry(accepted)
    errors.extend(_validate_branch_master(branch_rows, branch_headers))
    if errors:
        raise RegistryValidationError(tuple(errors))

    value = {
        "branches": list(APPROVED_BRANCHES),
        "products": {
            code: {
                "uqc": "OTH",
                "supply_class": "PRIVATE_HEALTHCARE_SERVICE",
                "allowed_zero_rate_reason": "VATEX-SA-HEA",
            }
            for code in sorted(product_codes)
        },
    }
    json_bytes = canonical_json_bytes(value)
    return BuildResult(
        value=value,
        json_bytes=json_bytes,
        accepted_registry_sha256=hashlib.sha256(accepted_bytes).hexdigest(),
        branch_master_sha256=hashlib.sha256(branch_bytes).hexdigest(),
        product_code_set_sha256=product_code_set_sha256(product_codes),
        output_sha256=hashlib.sha256(json_bytes).hexdigest(),
    )


def _ensure_private_output_directory(directory: Path) -> None:
    missing_directories = []
    current = directory
    while not current.exists():
        missing_directories.append(current)
        if current.parent == current:
            break
        current = current.parent

    for missing_directory in reversed(missing_directories):
        try:
            missing_directory.mkdir(mode=0o700)
            missing_directory.chmod(0o700)
        except FileExistsError:
            pass
        if (
            not missing_directory.is_dir()
            or stat.S_IMODE(missing_directory.stat().st_mode) != 0o700
        ):
            raise RegistryValidationError(("unsafe output directory",))

    if not directory.is_dir() or stat.S_IMODE(directory.stat().st_mode) != 0o700:
        raise RegistryValidationError(("unsafe output directory",))


def _atomic_create_private_file(contents: bytes, output: Path, *, os_impl=os) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    temporary = Path(temporary_name)
    published = False
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os_impl.link(temporary, output)
        published = True
        directory_descriptor = os.open(output.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except Exception:
        if published:
            os_impl.unlink(output)
        raise
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _hash_report_path(output: Path) -> Path:
    return output.with_name(f"{output.stem}.hash-report.json")


def _hash_report_bytes(result: BuildResult) -> bytes:
    return canonical_json_bytes({
        "accepted_registry_sha256": result.accepted_registry_sha256,
        "branch_count": len(result.value["branches"]),
        "branch_master_sha256": result.branch_master_sha256,
        "product_count": len(result.value["products"]),
        "product_code_set_sha256": result.product_code_set_sha256,
        "runtime_master_sha256": result.output_sha256,
    })


def write_runtime_master(result: BuildResult, output: Path, *, os_impl=os) -> Path:
    output = Path(output)
    report = _hash_report_path(output)
    _ensure_private_output_directory(output.parent)
    for destination in (output, report):
        if destination.exists():
            raise FileExistsError(f"refusing to overwrite existing output: {destination}")

    published = []
    try:
        _atomic_create_private_file(result.json_bytes, output, os_impl=os_impl)
        published.append(output)
        _atomic_create_private_file(_hash_report_bytes(result), report, os_impl=os_impl)
        published.append(report)
    except Exception:
        for destination in reversed(published):
            try:
                os_impl.unlink(destination)
            except FileNotFoundError:
                pass
        raise
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accepted-registry", required=True, type=Path)
    parser.add_argument("--branch-master", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args(argv)
    try:
        result = build_runtime_master(arguments.accepted_registry, arguments.branch_master)
        write_runtime_master(result, arguments.output)
    except (RegistryValidationError, OSError) as error:
        print(f"error: {error}")
        return 1
    print("product_count=300")
    print("branch_count=4")
    print(f"accepted_registry_sha256={result.accepted_registry_sha256}")
    print(f"branch_master_sha256={result.branch_master_sha256}")
    print(f"product_code_set_sha256={result.product_code_set_sha256}")
    print(f"output_sha256={result.output_sha256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
