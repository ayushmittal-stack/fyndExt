import csv
import copy
import hashlib
import http.server
import io
import json
import os
import pathlib
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from unittest import mock


SCRIPT_DIRECTORY = pathlib.Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import upload_products


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


@contextmanager
def loopback_server(*, status=200, body=b"{}", response_headers=None, delay=0):
    captured = {"requests": 0, "paths": []}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            captured["requests"] += 1
            captured["paths"].append(self.path)
            length = int(self.headers.get("Content-Length", "0"))
            captured["authorization"] = self.headers.get("Authorization")
            captured["content_type"] = self.headers.get("Content-Type")
            captured["accept"] = self.headers.get("Accept")
            captured["body"] = self.rfile.read(length)
            if delay:
                time.sleep(delay)
            self.send_response(status)
            for name, value in (response_headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, format, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = False
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, captured
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@contextmanager
def raw_loopback_server(response_bytes):
    captured = {"requests": 0, "request": b""}

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            captured["requests"] += 1
            self.connection.settimeout(1)
            request = b""
            while b"\r\n\r\n" not in request:
                chunk = self.connection.recv(4096)
                if not chunk:
                    break
                request += chunk
            header_bytes, _, body = request.partition(b"\r\n\r\n")
            content_length = 0
            for line in header_bytes.split(b"\r\n")[1:]:
                name, separator, value = line.partition(b":")
                if separator and name.lower() == b"content-length":
                    content_length = int(value.strip())
                    break
            while len(body) < content_length:
                chunk = self.connection.recv(content_length - len(body))
                if not chunk:
                    break
                body += chunk
            captured["request"] = header_bytes + b"\r\n\r\n" + body
            self.connection.sendall(response_bytes)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = Server(("127.0.0.1", 0), Handler)
    server.server_port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, captured
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def product_payload(codes=None):
    if codes is None:
        codes = [f"SKU-{index + 1:03d}" for index in range(300)]
    return {
        "ProductMasterList": [
            {"PRODUCT_CODE": code}
            for code in codes
        ]
    }


def product_response(codes=None):
    if codes is None:
        codes = [f"SKU-{index + 1:03d}" for index in range(300)]
    return {
        "ProductMasterList": [
            {"PRODUCT_CODE": code, "IsValidated": True}
            for code in reversed(codes)
        ],
        "ProductMasterLogs": {
            "IsSystemException": False,
            "SystemException": {},
            "TotalRecordsCount": len(codes),
            "SuccessRecordCount": len(codes),
            "ErrorRecordCount": 0,
        },
    }


def response_bytes(response):
    return json.dumps(response, ensure_ascii=False).encode("utf-8")


def assert_upload_error_has_no_chain(test_case, error, *sensitive_values):
    test_case.assertIsNone(error.__cause__)
    test_case.assertIsNone(error.__context__)
    rendered = "".join(traceback.format_exception(
        type(error), error, error.__traceback__
    ))
    for value in sensitive_values:
        test_case.assertNotIn(value, rendered)


class ProductMasterBuildTests(unittest.TestCase):
    def test_build_product_master_maps_all_300_rows_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "catalog.csv"
            write_catalog(source)

            result = upload_products.build_product_master(source)

            self.assertEqual(result.payload["ProductMasterList"][0], {
                "COMPANY_CODE": "Viva Radix",
                "SOURCE_ERP": "Fynd",
                "SUPPLIER_COUNTRY_CODE_ENGLISH": "SA",
                "PRODUCT_CODE": "SKU-001",
                "PRODUCT_DESCRIPTION_1_ENGLISH": "Service 1",
                "PRODUCT_DESCRIPTION_1_LANG02": "خدمة 1",
                "PRODUCT_TYPE": "Service",
            })
            self.assertEqual(len(result.payload["ProductMasterList"]), 300)
            self.assertEqual(len(result.defaulted_tax_codes), 29)
            self.assertIn("خدمة 1".encode("utf-8"), result.payload_bytes)
            self.assertTrue(result.payload_bytes.endswith(b"\n"))
            self.assertEqual(
                result.payload_sha256,
                hashlib.sha256(result.payload_bytes).hexdigest(),
            )
            self.assertEqual(
                result.source_sha256,
                hashlib.sha256(source.read_bytes()).hexdigest(),
            )

    def test_build_hashes_and_parses_one_source_byte_snapshot(self):
        original_open = pathlib.Path.open
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "catalog.csv"
            replacement = pathlib.Path(directory) / "replacement.csv"
            write_catalog(source)
            original_bytes = b"\xef\xbb\xbf" + source.read_bytes()
            source.write_bytes(original_bytes)
            write_catalog(
                replacement,
                lambda rows: rows[0].__setitem__("Name", "Replacement Service"),
            )
            replacement_hash = hashlib.sha256(replacement.read_bytes()).hexdigest()
            source_open_count = 0

            def replace_path_after_source_open(path, *args, **kwargs):
                nonlocal source_open_count
                handle = original_open(path, *args, **kwargs)
                if path == source:
                    source_open_count += 1
                    if source_open_count == 1:
                        os.replace(replacement, source)
                return handle

            with mock.patch.object(
                pathlib.Path,
                "open",
                autospec=True,
                side_effect=replace_path_after_source_open,
            ):
                result = upload_products.build_product_master(source)

        self.assertEqual(source_open_count, 1)
        self.assertEqual(
            result.payload["ProductMasterList"][0][
                "PRODUCT_DESCRIPTION_1_ENGLISH"
            ],
            "Service 1",
        )
        self.assertEqual(
            result.source_sha256,
            hashlib.sha256(original_bytes).hexdigest(),
        )
        self.assertNotEqual(result.source_sha256, replacement_hash)


class ProductMasterValidationTests(unittest.TestCase):
    def build_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "catalog.csv"
            write_catalog(source)
            return upload_products.build_product_master(source)

    def assert_catalog_error(self, mutate, expected):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "catalog.csv"
            write_catalog(source, mutate)
            with self.assertRaises(upload_products.CatalogValidationError) as caught:
                upload_products.build_product_master(source)
        errors = "\n".join(caught.exception.errors)
        self.assertIn(expected, errors)
        return errors

    def assert_catalog_file_error(self, change, expected):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "catalog.csv"
            write_catalog(source)
            change(source)
            with self.assertRaises(upload_products.CatalogValidationError) as caught:
                upload_products.build_product_master(source)
        self.assertIn(expected, "\n".join(caught.exception.errors))

    def test_rejects_missing_headers(self):
        self.assert_catalog_file_error(
            lambda path: path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "Seller Identifier", "Missing Seller Identifier", 1
                ),
                encoding="utf-8",
            ),
            "missing headers",
        )

    def test_rejects_duplicate_headers(self):
        self.assert_catalog_file_error(
            lambda path: path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "Unused 000", "Seller Identifier", 1
                ),
                encoding="utf-8",
            ),
            "duplicate headers",
        )

    def test_rejects_wrong_row_count(self):
        self.assert_catalog_error(lambda rows: rows.pop(), "row count")

    def test_rejects_ragged_row_width(self):
        def append_ragged_row(path):
            with path.open("a", encoding="utf-8", newline="") as handle:
                handle.write("only,three,fields\r\n")

        self.assert_catalog_file_error(append_ragged_row, "row 302")

    def test_rejects_blank_product_code(self):
        errors = self.assert_catalog_error(
            lambda rows: rows[0].__setitem__("Seller Identifier", ""),
            "required PRODUCT_CODE",
        )
        self.assertIn("row 2", errors)

    def test_rejects_case_insensitive_duplicate_product_code(self):
        self.assert_catalog_error(
            lambda rows: rows[1].__setitem__("Seller Identifier", "sku-001"),
            "duplicate PRODUCT_CODE",
        )

    def test_rejects_overlength_product_code(self):
        self.assert_catalog_error(
            lambda rows: rows[0].__setitem__("Seller Identifier", "X" * 51),
            "PRODUCT_CODE exceeds 50",
        )

    def test_rejects_blank_english_name(self):
        self.assert_catalog_error(
            lambda rows: rows[0].__setitem__("Name", ""),
            "required PRODUCT_DESCRIPTION_1_ENGLISH",
        )

    def test_rejects_overlength_english_name(self):
        self.assert_catalog_error(
            lambda rows: rows[0].__setitem__("Name", "N" * 251),
            "PRODUCT_DESCRIPTION_1_ENGLISH exceeds 250",
        )

    def test_rejects_arabic_name_without_arabic_script(self):
        self.assert_catalog_error(
            lambda rows: rows[0].__setitem__(
                "Translated Product Name (Arabic)", "English only"
            ),
            "must contain Arabic script",
        )

    def test_rejects_blank_arabic_name(self):
        self.assert_catalog_error(
            lambda rows: rows[0].__setitem__("Translated Product Name (Arabic)", ""),
            "required PRODUCT_DESCRIPTION_1_LANG02",
        )

    def test_rejects_overlength_arabic_name(self):
        self.assert_catalog_error(
            lambda rows: rows[0].__setitem__(
                "Translated Product Name (Arabic)", "ع" * 501
            ),
            "PRODUCT_DESCRIPTION_1_LANG02 exceeds 500",
        )

    def test_rejects_replacement_null_and_bidi_controls(self):
        for unsafe in ("bad\ufffd", "bad\x00", "bad\u202e"):
            with self.subTest(unsafe=unsafe):
                self.assert_catalog_error(
                    lambda rows, value=unsafe: rows[0].__setitem__("Name", value),
                    "unsafe",
                )

    def test_rejects_literal_question_mark_mojibake(self):
        self.assert_catalog_error(
            lambda rows: rows[0].__setitem__("Name", "????"),
            "unsafe PRODUCT_DESCRIPTION_1_ENGLISH",
        )

    def test_rejects_spreadsheet_formula_prefixes(self):
        for prefix in "=+-@":
            with self.subTest(prefix=prefix):
                self.assert_catalog_error(
                    lambda rows, value=prefix: rows[0].__setitem__(
                        "Seller Identifier", f"  {value}unsafe"
                    ),
                    "unsafe PRODUCT_CODE",
                )

    def test_rejects_invalid_categorical_values(self):
        cases = (
            ("Product Type", "goods", "invalid Product Type"),
            ("Verification Status", "approved", "invalid Verification Status"),
            ("Currency", "USD", "invalid Currency"),
            ("Country of Origin", "United Arab Emirates", "invalid Country of Origin"),
            ("Tax Rule Name", "Reduced VAT", "invalid Tax Rule Name"),
        )
        for header, value, expected in cases:
            with self.subTest(header=header):
                self.assert_catalog_error(
                    lambda rows, key=header, item=value: rows[0].__setitem__(key, item),
                    expected,
                )

    def test_rejects_invalid_tax_percentage(self):
        self.assert_catalog_error(
            lambda rows: rows[0].__setitem__("Tax percentage", "5"),
            "invalid Tax percentage",
        )

    def test_requires_exactly_29_defaulted_tax_codes(self):
        self.assert_catalog_error(
            lambda rows: rows[29].__setitem__("Tax percentage", ""),
            "exactly 29 blank Tax percentage values",
        )

    def test_request_omits_server_owned_and_unrelated_fields(self):
        row = self.build_valid().payload["ProductMasterList"][0]
        self.assertEqual(tuple(row), upload_products.PRODUCT_KEYS)
        for key in ("Tax percentage", "Verification Status", "IsValidated", "ValidationError"):
            self.assertNotIn(key, row)


class ProductMasterOfflineArtifactTests(unittest.TestCase):
    def build_valid(self, directory):
        source = pathlib.Path(directory) / "catalog.csv"
        write_catalog(source)
        return source, upload_products.build_product_master(source)

    def test_build_validation_report_uses_fixed_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            _, result = self.build_valid(directory)

            report = upload_products.build_validation_report(result)

        self.assertEqual(report, {
            "status": "valid",
            "source_sha256": result.source_sha256,
            "payload_sha256": result.payload_sha256,
            "product_count": 300,
            "full_catalog_product_count": 300,
            "request_product_count": 300,
            "selection_mode": "all",
            "selected_product_code": None,
            "excluded_product_code": None,
            "defaulted_tax_count": 29,
            "defaulted_tax_product_codes": list(result.defaulted_tax_codes),
            "constants": {
                "COMPANY_CODE": "Viva Radix",
                "SOURCE_ERP": "Fynd",
                "SUPPLIER_COUNTRY_CODE_ENGLISH": "SA",
                "PRODUCT_TYPE": "Service",
            },
        })

    def test_generates_private_payload_and_report_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source, result = self.build_valid(directory)
            output_dir = pathlib.Path(directory) / "private-output"

            prepared_dir = upload_products.prepare_output_dir(
                output_dir, SCRIPT_DIRECTORY.parents[1]
            )
            upload_products.generate_offline_artifacts(result, prepared_dir)

            payload_path = prepared_dir / "product-master-payload.json"
            report_path = prepared_dir / "validation-report.json"
            self.assertEqual(prepared_dir, output_dir.resolve())
            self.assertEqual(prepared_dir.stat().st_mode & 0o777, 0o700)
            self.assertEqual(payload_path.read_bytes(), result.payload_bytes)
            self.assertEqual(json.loads(report_path.read_text(encoding="utf-8")), {
                "status": "valid",
                "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "payload_sha256": result.payload_sha256,
                "product_count": 300,
                "full_catalog_product_count": 300,
                "request_product_count": 300,
                "selection_mode": "all",
                "selected_product_code": None,
                "excluded_product_code": None,
                "defaulted_tax_count": 29,
                "defaulted_tax_product_codes": list(result.defaulted_tax_codes),
                "constants": {
                    "COMPANY_CODE": "Viva Radix",
                    "SOURCE_ERP": "Fynd",
                    "SUPPLIER_COUNTRY_CODE_ENGLISH": "SA",
                    "PRODUCT_TYPE": "Service",
                },
            })
            self.assertEqual(payload_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(report_path.stat().st_mode & 0o777, 0o600)

    def test_atomic_write_closes_descriptor_when_fchmod_fails(self):
        real_mkstemp = tempfile.mkstemp
        captured = []

        def capture_mkstemp(*args, **kwargs):
            result = real_mkstemp(*args, **kwargs)
            captured.append(result)
            return result

        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "artifact.json"
            with mock.patch.object(
                upload_products.tempfile,
                "mkstemp",
                side_effect=capture_mkstemp,
            ), mock.patch.object(
                upload_products.os,
                "fchmod",
                side_effect=OSError("injected fchmod failure"),
            ):
                with self.assertRaises(OSError):
                    upload_products.atomic_write_private(destination, b"private")

            self.assertEqual(len(captured), 1)
            file_descriptor, temporary_name = captured[0]
            with self.assertRaises(OSError):
                os.fstat(file_descriptor)
            self.assertFalse(pathlib.Path(temporary_name).exists())
            self.assertFalse(destination.exists())

    def test_rejects_unsafe_output_directories(self):
        repo_root = SCRIPT_DIRECTORY.parents[1]
        with tempfile.TemporaryDirectory() as directory:
            for output_dir in (pathlib.Path("/"), pathlib.Path.home(), repo_root):
                with self.subTest(output_dir=output_dir):
                    with self.assertRaises(ValueError):
                        upload_products.prepare_output_dir(output_dir, repo_root)

    def test_cli_writes_offline_artifacts_without_oeis_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            source, result = self.build_valid(directory)
            output_dir = pathlib.Path(directory) / "private-output"
            environment = {
                key: value for key, value in os.environ.items()
                if not key.startswith("OEIS_")
            }

            completed = subprocess.run(
                [
                    sys.executable, str(SCRIPT_DIRECTORY / "upload_products.py"),
                    "--input", str(source), "--output-dir", str(output_dir),
                ],
                cwd=SCRIPT_DIRECTORY,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("product_count=300", completed.stdout)
            self.assertIn(result.payload_sha256, completed.stdout)
            self.assertEqual(
                (output_dir / "product-master-payload.json").read_bytes(),
                result.payload_bytes,
            )

    def test_cli_smoke_writes_exact_named_request_and_full_catalog_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            source, full_catalog_result = self.build_valid(directory)
            output_dir = pathlib.Path(directory) / "smoke-output"

            completed = subprocess.run(
                [
                    sys.executable, str(SCRIPT_DIRECTORY / "upload_products.py"),
                    "--input", str(source), "--output-dir", str(output_dir),
                    "--smoke-product-code", "SKU-042",
                ],
                cwd=SCRIPT_DIRECTORY,
                env={key: value for key, value in os.environ.items()
                     if not key.startswith("OEIS_")},
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload_bytes = (output_dir / "product-master-payload.json").read_bytes()
            payload = json.loads(payload_bytes)
            report = json.loads((
                output_dir / "validation-report.json"
            ).read_text(encoding="utf-8"))
            expected_product = next(
                product
                for product in full_catalog_result.payload["ProductMasterList"]
                if product["PRODUCT_CODE"] == "SKU-042"
            )
            self.assertEqual(
                payload,
                {"ProductMasterList": [expected_product]},
            )
            self.assertIn("product_count=1", completed.stdout)
            payload_sha256 = hashlib.sha256(payload_bytes).hexdigest()
            self.assertEqual(
                report["payload_sha256"], payload_sha256
            )
            self.assertIn(f"payload_sha256={payload_sha256}", completed.stdout)
            self.assertEqual(report["source_sha256"], hashlib.sha256(
                source.read_bytes()
            ).hexdigest())
            self.assertEqual(report["product_count"], 1)
            self.assertEqual(report["full_catalog_product_count"], 300)
            self.assertEqual(report["request_product_count"], 1)
            self.assertEqual(report["selection_mode"], "smoke_product_code")
            self.assertEqual(report["selected_product_code"], "SKU-042")
            self.assertIsNone(report["excluded_product_code"])
            self.assertEqual(report["defaulted_tax_count"], 29)

    def test_cli_exclusion_writes_other_299_products(self):
        with tempfile.TemporaryDirectory() as directory:
            source, full_catalog_result = self.build_valid(directory)
            output_dir = pathlib.Path(directory) / "bulk-output"

            completed = subprocess.run(
                [
                    sys.executable, str(SCRIPT_DIRECTORY / "upload_products.py"),
                    "--input", str(source), "--output-dir", str(output_dir),
                    "--exclude-product-code", "SKU-042",
                ],
                cwd=SCRIPT_DIRECTORY,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload_bytes = (output_dir / "product-master-payload.json").read_bytes()
            payload = json.loads(payload_bytes)
            report = json.loads((
                output_dir / "validation-report.json"
            ).read_text(encoding="utf-8"))
            expected_products = [
                product
                for product in full_catalog_result.payload["ProductMasterList"]
                if product["PRODUCT_CODE"] != "SKU-042"
            ]
            self.assertEqual(
                payload,
                {"ProductMasterList": expected_products},
            )
            self.assertIn("product_count=299", completed.stdout)
            payload_sha256 = hashlib.sha256(payload_bytes).hexdigest()
            self.assertEqual(report["payload_sha256"], payload_sha256)
            self.assertIn(f"payload_sha256={payload_sha256}", completed.stdout)
            self.assertEqual(report["product_count"], 299)
            self.assertEqual(report["full_catalog_product_count"], 300)
            self.assertEqual(report["request_product_count"], 299)
            self.assertEqual(report["selection_mode"], "exclude_product_code")
            self.assertIsNone(report["selected_product_code"])
            self.assertEqual(report["excluded_product_code"], "SKU-042")

    def test_selection_modes_still_validate_every_catalog_row(self):
        for flag in ("--smoke-product-code", "--exclude-product-code"):
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as directory:
                source = pathlib.Path(directory) / "catalog.csv"
                write_catalog(
                    source,
                    lambda rows: rows[-1].__setitem__("Name", ""),
                )
                output_dir = pathlib.Path(directory) / "output"

                completed = subprocess.run(
                    [
                        sys.executable,
                        str(SCRIPT_DIRECTORY / "upload_products.py"),
                        "--input", str(source),
                        "--output-dir", str(output_dir),
                        flag, "SKU-001",
                    ],
                    cwd=SCRIPT_DIRECTORY,
                    text=True,
                    capture_output=True,
                    check=False,
                )

                self.assertEqual(completed.returncode, 1)
                self.assertIn(
                    "required PRODUCT_DESCRIPTION_1_ENGLISH", completed.stderr
                )
                self.assertFalse(output_dir.exists())

    def test_cli_does_not_write_payload_when_validation_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "catalog.csv"
            write_catalog(source, lambda rows: rows[0].__setitem__("Name", ""))
            output_dir = pathlib.Path(directory) / "private-output"

            completed = subprocess.run(
                [
                    sys.executable, str(SCRIPT_DIRECTORY / "upload_products.py"),
                    "--input", str(source), "--output-dir", str(output_dir),
                ],
                cwd=SCRIPT_DIRECTORY,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 1)
            self.assertIn("required PRODUCT_DESCRIPTION_1_ENGLISH", completed.stderr)
            self.assertFalse((output_dir / "product-master-payload.json").exists())


class HttpConfigurationTests(unittest.TestCase):
    def valid_environment(self):
        return {
            "OEIS_BASE_URL": "https://oeis.example.test",
            "OEIS_API_KEY": "secret-key",
            "OEIS_TIMEOUT_MS": "30000",
            "OEIS_MAX_REQUEST_BYTES": "4194304",
            "OEIS_MAX_RESPONSE_BYTES": "4194304",
        }

    def assert_config_rejected(self, **changes):
        environment = self.valid_environment()
        environment.update(changes)
        with self.assertRaises(Exception) as caught:
            upload_products.load_http_config(
                environment, allow_insecure_http=False
            )
        self.assertNotIn("secret-key", str(caught.exception))


class HttpSubmissionTests(unittest.TestCase):
    def config_for(self, server, **changes):
        values = {
            "base_url": f"http://127.0.0.1:{server.server_port}",
            "api_key": "ephemeral-loopback-key",
            "timeout_seconds": 1.0,
            "max_request_bytes": 1024,
            "max_response_bytes": 1024,
        }
        values.update(changes)
        return upload_products.HttpConfig(**values)

    def test_posts_fixed_path_headers_and_exact_body_once(self):
        payload_bytes = b'{"ProductMasterList":[]}\n'
        with loopback_server(status=200, body=b'{"ok":true}') as (server, captured):
            status, response = upload_products.submit_payload(
                payload_bytes, self.config_for(server)
            )

        self.assertEqual(status, 200)
        self.assertEqual(response, b'{"ok":true}')
        self.assertEqual(captured["requests"], 1)
        self.assertEqual(captured["paths"], [
            "/API/InvoicingMasterAPI/UpdateData"
        ])
        self.assertEqual(captured["authorization"], "APIkey ephemeral-loopback-key")
        self.assertEqual(captured["content_type"], "application/json; charset=utf-8")
        self.assertEqual(captured["accept"], "application/json")
        self.assertEqual(captured["body"], payload_bytes)

    def test_does_not_follow_302_redirect(self):
        with loopback_server(
            status=302,
            body=b"redirect body must stay private",
            response_headers={"Location": "/followed"},
        ) as (server, captured):
            with self.assertRaises(Exception) as caught:
                upload_products.submit_payload(b"{}", self.config_for(server))

        self.assertEqual(captured["requests"], 1)
        self.assertEqual(captured["paths"], [
            "/API/InvoicingMasterAPI/UpdateData"
        ])
        self.assertNotIn("ephemeral-loopback-key", str(caught.exception))
        self.assertNotIn("redirect body", str(caught.exception))

    def test_http_500_is_attempted_once(self):
        with loopback_server(
            status=500, body=b"vendor internal details"
        ) as (server, captured):
            with self.assertRaises(Exception) as caught:
                upload_products.submit_payload(b"{}", self.config_for(server))

        self.assertEqual(captured["requests"], 1)
        self.assertNotIn("vendor internal details", str(caught.exception))
        self.assertNotIn("ephemeral-loopback-key", str(caught.exception))
        assert_upload_error_has_no_chain(
            self,
            caught.exception,
            "vendor internal details",
            "ephemeral-loopback-key",
            str(server.server_port),
        )

    def test_rejects_response_overflow(self):
        with loopback_server(status=200, body=b"123456") as (server, captured):
            with self.assertRaises(Exception) as caught:
                upload_products.submit_payload(
                    b"{}", self.config_for(server, max_response_bytes=5)
                )

        self.assertEqual(captured["requests"], 1)
        self.assertNotIn("123456", str(caught.exception))
        self.assertNotIn("ephemeral-loopback-key", str(caught.exception))

    def test_timeout_is_reported_without_sensitive_details(self):
        with loopback_server(status=200, body=b"{}", delay=0.05) as (server, captured):
            with self.assertRaises(Exception) as caught:
                upload_products.submit_payload(
                    b"{}", self.config_for(server, timeout_seconds=0.01)
                )

        self.assertEqual(captured["requests"], 1)
        self.assertNotIn("ephemeral-loopback-key", str(caught.exception))
        self.assertNotIn(str(server.server_port), str(caught.exception))
        assert_upload_error_has_no_chain(
            self,
            caught.exception,
            "ephemeral-loopback-key",
            str(server.server_port),
        )

    def test_malformed_status_maps_http_exception_to_fixed_safe_error(self):
        malformed_status = b"private-status-line\r\nPrivate-Header: private-value\r\n\r\n"
        with raw_loopback_server(malformed_status) as (server, captured):
            caught = None
            try:
                upload_products.submit_payload(b"{}", self.config_for(server))
            except BaseException as error:
                caught = error

        self.assertIsInstance(caught, upload_products.UploadError)
        self.assertEqual(caught.code, "network_error")
        self.assertEqual(captured["requests"], 1)
        assert_upload_error_has_no_chain(
            self,
            caught,
            "private-status-line",
            "Private-Header",
            "private-value",
            "ephemeral-loopback-key",
            str(server.server_port),
        )

    def test_direct_invalid_loopback_origin_maps_to_fixed_safe_error(self):
        config = upload_products.HttpConfig(
            base_url="http://127.0.0.1:invalid-port",
            api_key="ephemeral-loopback-key",
            timeout_seconds=1.0,
            max_request_bytes=1024,
            max_response_bytes=1024,
        )

        with self.assertRaises(upload_products.UploadError) as caught:
            upload_products.submit_payload(b"{}", config)

        self.assertEqual(caught.exception.code, "invalid_http_config")
        self.assertNotIn("invalid-port", str(caught.exception))
        self.assertNotIn("ephemeral-loopback-key", str(caught.exception))
        assert_upload_error_has_no_chain(
            self,
            caught.exception,
            "invalid-port",
            "ephemeral-loopback-key",
        )


class HttpConfigurationValueTests(HttpConfigurationTests):
    def test_loads_literal_valid_configuration(self):
        config = upload_products.load_http_config(
            self.valid_environment(), allow_insecure_http=False
        )

        self.assertEqual(config.base_url, "https://oeis.example.test")
        self.assertEqual(config.api_key, "secret-key")
        self.assertEqual(config.timeout_seconds, 30.0)
        self.assertEqual(config.max_request_bytes, 4194304)
        self.assertEqual(config.max_response_bytes, 4194304)

    def test_defaults_timeout_and_size_caps(self):
        config = upload_products.load_http_config({
            "OEIS_BASE_URL": "https://oeis.example.test/",
            "OEIS_API_KEY": "secret-key",
        }, allow_insecure_http=False)

        self.assertEqual(config.base_url, "https://oeis.example.test")
        self.assertEqual(config.timeout_seconds, 30.0)
        self.assertEqual(config.max_request_bytes, 4194304)
        self.assertEqual(config.max_response_bytes, 4194304)

    def test_rejects_missing_base_url_or_api_key(self):
        for missing in ("OEIS_BASE_URL", "OEIS_API_KEY"):
            with self.subTest(missing=missing):
                environment = self.valid_environment()
                del environment[missing]
                with self.assertRaises(Exception):
                    upload_products.load_http_config(
                        environment, allow_insecure_http=False
                    )

    def test_rejects_whitespace_and_control_characters_in_credentials(self):
        cases = (
            ("OEIS_BASE_URL", " https://oeis.example.test"),
            ("OEIS_BASE_URL", "https://oeis.example.test "),
            ("OEIS_BASE_URL", "https://oeis.example.test\n"),
            ("OEIS_API_KEY", " secret-key"),
            ("OEIS_API_KEY", "secret-key "),
            ("OEIS_API_KEY", "secret\r\nInjected: value"),
        )
        for key, value in cases:
            with self.subTest(key=key, value=repr(value)):
                self.assert_config_rejected(**{key: value})

    def test_rejects_non_origin_urls(self):
        for url in (
            "https://user:pass@oeis.example.test",
            "https://oeis.example.test?query=value",
            "https://oeis.example.test#fragment",
            "https://oeis.example.test/vendor/path",
            "https:///missing-host",
            "ftp://oeis.example.test",
        ):
            with self.subTest(url=url):
                self.assert_config_rejected(OEIS_BASE_URL=url)

    def test_rejects_invalid_ports(self):
        for url in (
            "https://oeis.example.test:",
            "https://oeis.example.test:not-a-port",
            "https://oeis.example.test:-1",
            "https://oeis.example.test:0",
            "https://oeis.example.test:65536",
        ):
            with self.subTest(url=url):
                self.assert_config_rejected(OEIS_BASE_URL=url)

    def test_mapped_config_error_has_no_underlying_exception_context(self):
        environment = self.valid_environment()
        environment["OEIS_BASE_URL"] = (
            "https://oeis.example.test:sensitive-invalid-port"
        )

        with self.assertRaises(upload_products.UploadError) as caught:
            upload_products.load_http_config(
                environment, allow_insecure_http=False
            )

        self.assertEqual(caught.exception.code, "invalid_http_config")
        assert_upload_error_has_no_chain(
            self,
            caught.exception,
            "sensitive-invalid-port",
            "secret-key",
        )

    def test_requires_explicit_allowance_for_http(self):
        self.assert_config_rejected(OEIS_BASE_URL="http://127.0.0.1:8000")

        config = upload_products.load_http_config({
            "OEIS_BASE_URL": "http://127.0.0.1:8000",
            "OEIS_API_KEY": "secret-key",
        }, allow_insecure_http=True)

        self.assertEqual(config.base_url, "http://127.0.0.1:8000")

    def test_rejects_invalid_positive_integer_options(self):
        for key in (
            "OEIS_TIMEOUT_MS",
            "OEIS_MAX_REQUEST_BYTES",
            "OEIS_MAX_RESPONSE_BYTES",
        ):
            for value in ("", "0", "-1", "1.5", "not-a-number"):
                with self.subTest(key=key, value=value):
                    self.assert_config_rejected(**{key: value})

    def test_rejects_unusable_option_magnitudes_with_fixed_error(self):
        cases = (
            ("OEIS_TIMEOUT_MS", "300001"),
            ("OEIS_MAX_REQUEST_BYTES", "16777217"),
            ("OEIS_MAX_RESPONSE_BYTES", "16777217"),
            ("OEIS_TIMEOUT_MS", "9" * 10000),
            ("OEIS_MAX_REQUEST_BYTES", "9" * 10000),
            ("OEIS_MAX_RESPONSE_BYTES", "9" * 10000),
        )
        for key, value in cases:
            with self.subTest(key=key, length=len(value)):
                environment = self.valid_environment()
                environment[key] = value
                with self.assertRaises(upload_products.UploadError) as caught:
                    upload_products.load_http_config(
                        environment, allow_insecure_http=False
                    )
                self.assertEqual(caught.exception.code, "invalid_http_config")

    def test_rejects_internal_url_whitespace_and_ambiguous_hosts(self):
        for url in (
            "https://oeis .example.test",
            "https://127.0.0.999",
            "https://example..test",
            "https://-oeis.example.test",
            "https://oeis_.example.test",
        ):
            with self.subTest(url=url):
                environment = self.valid_environment()
                environment["OEIS_BASE_URL"] = url
                with self.assertRaises(upload_products.UploadError) as caught:
                    upload_products.load_http_config(
                        environment, allow_insecure_http=False
                    )
                self.assertEqual(caught.exception.code, "invalid_http_config")

    def test_rejects_request_overflow_before_network_access(self):
        config = upload_products.HttpConfig(
            base_url="http://127.0.0.1:1",
            api_key="secret-key",
            timeout_seconds=1.0,
            max_request_bytes=3,
            max_response_bytes=100,
        )

        with self.assertRaises(Exception) as caught:
            upload_products.submit_payload(b"four", config)

        self.assertNotIn("secret-key", str(caught.exception))


class ResponseReconciliationTests(unittest.TestCase):
    def reconcile(self, response):
        return upload_products.reconcile_response(
            product_payload(), response_bytes(response)
        )

    def assert_malformed(self, response):
        result = self.reconcile(response)
        self.assertFalse(result.is_complete)
        self.assertFalse(result.is_structurally_valid)
        self.assertEqual(result.accepted_codes, ())
        return result

    def test_reconciles_complete_shuffled_response_by_exact_code(self):
        result = self.reconcile(product_response())

        self.assertTrue(result.is_complete)
        self.assertTrue(result.is_structurally_valid)
        self.assertEqual(len(result.rows), 300)
        self.assertEqual(result.rows[0].product_code, "SKU-001")
        self.assertEqual(result.rows[-1].product_code, "SKU-300")
        self.assertEqual(result.accepted_codes, tuple(
            f"SKU-{index + 1:03d}" for index in range(300)
        ))

    def test_reconciles_complete_one_and_299_product_requests(self):
        code_sets = (
            ["SKU-042"],
            [f"SKU-{index + 1:03d}" for index in range(300)
             if index + 1 != 42],
        )
        for codes in code_sets:
            with self.subTest(request_count=len(codes)):
                result = upload_products.reconcile_response(
                    product_payload(codes), response_bytes(product_response(codes))
                )

                self.assertTrue(result.is_complete)
                self.assertTrue(result.is_structurally_valid)
                self.assertEqual(
                    tuple(row.product_code for row in result.rows), tuple(codes)
                )
                self.assertEqual(result.accepted_codes, tuple(codes))

    def test_reconciles_mathematically_integral_decimal_count_tokens(self):
        codes = ["SKU-042"]
        response = product_response(codes)
        response["ProductMasterLogs"].update({
            "TotalRecordsCount": 1.0,
            "SuccessRecordCount": 1.0,
            "ErrorRecordCount": 0.0,
        })

        result = upload_products.reconcile_response(
            product_payload(codes), response_bytes(response)
        )

        self.assertTrue(result.is_complete)
        self.assertTrue(result.is_structurally_valid)
        self.assertEqual(result.accepted_codes, ("SKU-042",))

    def test_dynamic_requests_report_business_failures_as_partial(self):
        code_sets = (
            ["SKU-042"],
            [f"SKU-{index + 1:03d}" for index in range(300)
             if index + 1 != 42],
        )
        for codes in code_sets:
            with self.subTest(request_count=len(codes)):
                response = product_response(codes)
                failed_row = response["ProductMasterList"][0]
                failed_row.update({
                    "IsValidated": False,
                    "ValidationError": {"ErrorMessage": "Rejected by OEIS"},
                })
                response["ProductMasterLogs"].update({
                    "SuccessRecordCount": len(codes) - 1,
                    "ErrorRecordCount": 1,
                })

                result = upload_products.reconcile_response(
                    product_payload(codes), response_bytes(response)
                )

                self.assertFalse(result.is_complete)
                self.assertTrue(result.is_structurally_valid)
                self.assertEqual(result.error_code, "partial_failure")
                self.assertEqual(len(result.accepted_codes), len(codes) - 1)

    def test_dynamic_requests_require_exact_response_and_log_counts(self):
        for codes in (
            ["SKU-042"],
            [f"SKU-{index + 1:03d}" for index in range(299)],
        ):
            with self.subTest(request_count=len(codes)):
                response = product_response(codes)
                response["ProductMasterLogs"]["TotalRecordsCount"] = 300

                result = upload_products.reconcile_response(
                    product_payload(codes), response_bytes(response)
                )

                self.assertFalse(result.is_complete)
                self.assertFalse(result.is_structurally_valid)

    def test_rejects_empty_duplicate_and_oversized_requests(self):
        invalid_code_sets = (
            [],
            ["SKU-001", "SKU-001"],
            [f"SKU-{index + 1:03d}" for index in range(301)],
        )
        for codes in invalid_code_sets:
            with self.subTest(request_count=len(codes)):
                result = upload_products.reconcile_response(
                    product_payload(codes), response_bytes(product_response(codes))
                )

                self.assertFalse(result.is_complete)
                self.assertFalse(result.is_structurally_valid)
                self.assertEqual(result.accepted_codes, ())

    def test_rejects_invalid_json(self):
        result = upload_products.reconcile_response(
            product_payload(), b'{"ProductMasterList":'
        )

        self.assertFalse(result.is_structurally_valid)
        self.assertEqual(result.accepted_codes, ())

    def test_rejects_deeply_nested_json_without_raising(self):
        deeply_nested = (b"[" * 2000) + b"0" + (b"]" * 2000)

        result = upload_products.reconcile_response(
            product_payload(), deeply_nested
        )

        self.assertFalse(result.is_structurally_valid)
        self.assertEqual(result.accepted_codes, ())

    def test_rejects_missing_product_list_or_logs(self):
        for missing in ("ProductMasterList", "ProductMasterLogs"):
            with self.subTest(missing=missing):
                response = product_response()
                del response[missing]
                self.assert_malformed(response)

    def test_rejects_unknown_top_level_fields(self):
        response = product_response()
        response["UnexpectedStatus"] = {"accepted": True}

        self.assert_malformed(response)

    def test_permits_only_documented_sibling_master_pairs(self):
        response = product_response()
        response.update({
            "CompanyMasterList": [], "CompanyMasterLogs": {},
            "CustomerMasterList": [], "CustomerMasterLogs": {},
            "BranchMasterList": [], "BranchMasterLogs": {},
        })

        result = self.reconcile(response)

        self.assertTrue(result.is_complete)

    def test_rejects_non_standard_json_constants_anywhere(self):
        for constant in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(constant=constant):
                response = product_response()
                response["CompanyMasterList"] = {"ignored": [constant]}

                self.assert_malformed(response)

    def test_rejects_wrong_container_and_row_types(self):
        mutations = (
            lambda item: item.__setitem__("ProductMasterList", {}),
            lambda item: item.__setitem__("ProductMasterLogs", []),
            lambda item: item["ProductMasterList"].__setitem__(0, "not-an-object"),
            lambda item: item["ProductMasterList"][0].__setitem__("PRODUCT_CODE", 1),
            lambda item: item["ProductMasterList"][0].__setitem__("IsValidated", 1),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                response = product_response()
                mutate(response)
                self.assert_malformed(response)

    def test_rejects_boolean_or_numeric_string_counts(self):
        for field in (
            "TotalRecordsCount", "SuccessRecordCount", "ErrorRecordCount"
        ):
            for value in (True, "300"):
                with self.subTest(field=field, value=value):
                    response = product_response()
                    response["ProductMasterLogs"][field] = value
                    self.assert_malformed(response)

    def test_rejects_non_integral_decimal_counts(self):
        for field in (
            "TotalRecordsCount", "SuccessRecordCount", "ErrorRecordCount"
        ):
            with self.subTest(field=field):
                response = product_response()
                response["ProductMasterLogs"][field] = 1.5
                self.assert_malformed(response)

    def test_rejects_system_exception_states(self):
        mutations = (
            lambda logs: logs.__setitem__("IsSystemException", True),
            lambda logs: logs.__setitem__("IsSystemException", 0),
            lambda logs: logs.__setitem__("SystemException", {"Message": "private"}),
            lambda logs: logs.__setitem__("SystemException", []),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                response = product_response()
                mutate(response["ProductMasterLogs"])
                self.assert_malformed(response)

    def test_rejects_negative_or_unreconciled_aggregate_counts(self):
        cases = (
            ("TotalRecordsCount", -1),
            ("SuccessRecordCount", -1),
            ("ErrorRecordCount", -1),
            ("TotalRecordsCount", 299),
            ("SuccessRecordCount", 299),
            ("ErrorRecordCount", 1),
        )
        for field, value in cases:
            with self.subTest(field=field, value=value):
                response = product_response()
                response["ProductMasterLogs"][field] = value
                self.assert_malformed(response)

    def test_rejects_duplicate_unknown_or_missing_codes(self):
        mutations = (
            lambda rows: rows[0].__setitem__("PRODUCT_CODE", rows[1]["PRODUCT_CODE"]),
            lambda rows: rows[0].__setitem__("PRODUCT_CODE", "UNKNOWN"),
            lambda rows: rows.pop(),
            lambda rows: rows[0].__setitem__("PRODUCT_CODE", "sku-300"),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                response = product_response()
                mutate(response["ProductMasterList"])
                self.assert_malformed(response)

    def test_structurally_valid_failed_row_is_partial(self):
        response = product_response()
        failed_row = response["ProductMasterList"][0]
        failed_row["IsValidated"] = False
        failed_row["ValidationError"] = {"ErrorMessage": "Rejected by OEIS"}
        response["ProductMasterLogs"].update({
            "SuccessRecordCount": 299,
            "ErrorRecordCount": 1,
        })

        result = self.reconcile(response)

        self.assertFalse(result.is_complete)
        self.assertTrue(result.is_structurally_valid)
        self.assertNotIn(failed_row["PRODUCT_CODE"], result.accepted_codes)
        self.assertEqual(len(result.accepted_codes), 299)

    def test_rejects_missing_validation_or_success_error_payload(self):
        mutations = (
            lambda row: row.pop("IsValidated"),
            lambda row: row.__setitem__(
                "ValidationError", {"ErrorMessage": "must not be here"}
            ),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                response = product_response()
                mutate(response["ProductMasterList"][0])
                self.assert_malformed(response)

    def test_rejects_invalid_failed_validation_error_shape(self):
        for error in (None, "message", {}, {"Other": "message"}, {"ErrorMessage": 1}):
            with self.subTest(error=error):
                response = product_response()
                row = response["ProductMasterList"][0]
                row["IsValidated"] = False
                row["ValidationError"] = error
                response["ProductMasterLogs"].update({
                    "SuccessRecordCount": 299,
                    "ErrorRecordCount": 1,
                })
                self.assert_malformed(response)


class ExecutionArtifactTests(unittest.TestCase):
    def test_writes_private_exact_response_results_and_registry(self):
        response = product_response()
        raw_response = response_bytes(response)
        result = upload_products.reconcile_response(product_payload(), raw_response)
        with tempfile.TemporaryDirectory() as directory:
            output_dir = pathlib.Path(directory)

            upload_products.write_execution_artifacts(
                output_dir, raw_response, result
            )

            response_path = output_dir / "oeis-response.json"
            results_path = output_dir / "oeis-product-results.csv"
            registry_path = output_dir / "accepted-products-registry.json"
            self.assertEqual(response_path.read_bytes(), raw_response)
            with results_path.open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(list(rows[0]), [
                "PRODUCT_CODE", "SOURCE_VERIFICATION_STATUS",
                "OEIS_IS_VALIDATED", "OEIS_ERROR",
            ])
            self.assertEqual(rows[0], {
                "PRODUCT_CODE": "SKU-001",
                "SOURCE_VERIFICATION_STATUS": "pending",
                "OEIS_IS_VALIDATED": "true",
                "OEIS_ERROR": "",
            })
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
            self.assertEqual(registry["products"]["SKU-001"], {
                "uqc": "OTH", "tax_category": "S", "tax_rate": "15.00",
            })
            self.assertEqual(len(registry["products"]), 300)
            for path in (response_path, results_path, registry_path):
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_partial_artifacts_sanitize_error_and_claim_only_accepted_codes(self):
        response = product_response()
        failed_row = response["ProductMasterList"][-1]
        failed_code = failed_row["PRODUCT_CODE"]
        failed_row["IsValidated"] = False
        failed_row["ValidationError"] = {
            "ErrorMessage": "=unsafe\n" + ("x" * 500)
        }
        response["ProductMasterLogs"].update({
            "SuccessRecordCount": 299, "ErrorRecordCount": 1,
        })
        raw_response = response_bytes(response)
        result = upload_products.reconcile_response(product_payload(), raw_response)
        with tempfile.TemporaryDirectory() as directory:
            output_dir = pathlib.Path(directory)

            upload_products.write_execution_artifacts(output_dir, raw_response, result)

            with (output_dir / "oeis-product-results.csv").open(
                encoding="utf-8", newline=""
            ) as handle:
                rows = list(csv.DictReader(handle))
            failed_result = next(
                row for row in rows if row["PRODUCT_CODE"] == failed_code
            )
            self.assertEqual(failed_result["OEIS_IS_VALIDATED"], "false")
            self.assertTrue(failed_result["OEIS_ERROR"].startswith("'=unsafe "))
            self.assertNotIn("\n", failed_result["OEIS_ERROR"])
            self.assertLessEqual(len(failed_result["OEIS_ERROR"]), 240)
            registry = json.loads((
                output_dir / "accepted-products-registry.json"
            ).read_text(encoding="utf-8"))
            self.assertNotIn(failed_code, registry["products"])
            self.assertEqual(len(registry["products"]), 299)

    def test_malformed_artifacts_make_no_acceptance_claims(self):
        response = product_response()
        response["ProductMasterList"][0]["PRODUCT_CODE"] = "UNKNOWN"
        raw_response = response_bytes(response)
        result = upload_products.reconcile_response(product_payload(), raw_response)
        with tempfile.TemporaryDirectory() as directory:
            output_dir = pathlib.Path(directory)

            upload_products.write_execution_artifacts(output_dir, raw_response, result)

            registry = json.loads((
                output_dir / "accepted-products-registry.json"
            ).read_text(encoding="utf-8"))
            self.assertEqual(registry, {"products": {}})
            with (output_dir / "oeis-product-results.csv").open(
                encoding="utf-8", newline=""
            ) as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 300)
            self.assertFalse(any(row["OEIS_IS_VALIDATED"] for row in rows))


class CliExecutionTests(unittest.TestCase):
    class AccessTrackingEnvironment(dict):
        def __init__(self, values):
            super().__init__(values)
            self.accesses = 0

        def get(self, key, default=None):
            self.accesses += 1
            return super().get(key, default)

    def write_valid_catalog(self, directory):
        source = pathlib.Path(directory) / "catalog.csv"
        write_catalog(source)
        return source

    def environment_for(self, server):
        return {
            "OEIS_BASE_URL": f"http://127.0.0.1:{server.server_port}",
            "OEIS_API_KEY": "ephemeral-cli-key",
            "OEIS_TIMEOUT_MS": "1000",
            "OEIS_MAX_REQUEST_BYTES": "4194304",
            "OEIS_MAX_RESPONSE_BYTES": "4194304",
        }

    def call_main(
        self,
        source,
        output_dir,
        *,
        execute=False,
        environ=None,
        smoke_product_code=None,
        exclude_product_code=None,
    ):
        arguments = ["--input", str(source), "--output-dir", str(output_dir)]
        if smoke_product_code is not None:
            arguments.extend(("--smoke-product-code", smoke_product_code))
        if exclude_product_code is not None:
            arguments.extend(("--exclude-product-code", exclude_product_code))
        if execute:
            arguments.extend(("--execute", "--allow-insecure-http"))
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            return_code = upload_products.main(arguments, environ=environ)
        return return_code, stdout.getvalue(), stderr.getvalue()

    def test_default_cli_never_invokes_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "output"
            with mock.patch.object(
                upload_products,
                "submit_payload",
                side_effect=AssertionError("offline mode attempted network"),
            ):
                return_code, _, stderr = self.call_main(
                    source, output_dir, environ={}
                )

        self.assertEqual(return_code, 0, stderr)

    def test_execute_rejects_blank_and_unknown_exact_codes_before_any_side_effect(self):
        cases = (
            ("smoke_product_code", "", "must not be blank"),
            ("exclude_product_code", "   ", "must not be blank"),
            ("smoke_product_code", "SKU-999", "unknown PRODUCT_CODE"),
            ("exclude_product_code", "SKU-999", "unknown PRODUCT_CODE"),
            ("smoke_product_code", "sku-001", "unknown PRODUCT_CODE"),
            ("exclude_product_code", " SKU-001 ", "unknown PRODUCT_CODE"),
        )
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            with loopback_server(
                status=200, body=response_bytes(product_response(["SKU-001"]))
            ) as (server, captured):
                for index, (selection, code, expected_error) in enumerate(cases):
                    output_dir = pathlib.Path(directory) / f"invalid-{index}"
                    environment = self.AccessTrackingEnvironment(
                        self.environment_for(server)
                    )

                    return_code, _, stderr = self.call_main(
                        source,
                        output_dir,
                        execute=True,
                        environ=environment,
                        **{selection: code},
                    )

                    with self.subTest(selection=selection, code=code):
                        self.assertEqual(return_code, 1)
                        self.assertIn(expected_error, stderr)
                        self.assertEqual(environment.accesses, 0)
                        self.assertFalse(output_dir.exists())
            self.assertEqual(captured["requests"], 0)

    def test_selection_flags_are_mutually_exclusive_without_side_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "output"
            environment = self.AccessTrackingEnvironment({})

            with mock.patch.object(
                upload_products,
                "submit_payload",
                side_effect=AssertionError("invalid selection attempted network"),
            ):
                return_code, _, stderr = self.call_main(
                    source,
                    output_dir,
                    execute=True,
                    environ=environment,
                    smoke_product_code="SKU-001",
                    exclude_product_code="SKU-002",
                )

            self.assertEqual(return_code, 1)
            self.assertIn("not allowed with argument", stderr)
            self.assertEqual(environment.accesses, 0)
            self.assertFalse(output_dir.exists())

    def test_smoke_execute_posts_one_row_and_accepts_one_of_one_logs(self):
        codes = ["SKU-042"]
        raw_response = response_bytes(product_response(codes))
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "smoke-output"
            with loopback_server(status=200, body=raw_response) as (server, captured):
                return_code, stdout, stderr = self.call_main(
                    source,
                    output_dir,
                    execute=True,
                    environ=self.environment_for(server),
                    smoke_product_code="SKU-042",
                )

            self.assertEqual(return_code, 0, stderr)
            self.assertEqual(captured["requests"], 1)
            request_payload = json.loads(captured["body"])
            self.assertEqual(
                [row["PRODUCT_CODE"]
                 for row in request_payload["ProductMasterList"]],
                codes,
            )
            self.assertEqual(
                captured["body"],
                (output_dir / "product-master-payload.json").read_bytes(),
            )
            self.assertIn("product_count=1", stdout)
            with (output_dir / "oeis-product-results.csv").open(
                encoding="utf-8", newline=""
            ) as handle:
                result_rows = list(csv.DictReader(handle))
            self.assertEqual(len(result_rows), 1)
            self.assertEqual(result_rows[0]["PRODUCT_CODE"], "SKU-042")
            self.assertEqual(result_rows[0]["OEIS_IS_VALIDATED"], "true")
            registry = json.loads((
                output_dir / "accepted-products-registry.json"
            ).read_text(encoding="utf-8"))
            self.assertEqual(list(registry["products"]), ["SKU-042"])

    def test_execute_submits_exact_generated_payload_and_returns_success(self):
        raw_response = response_bytes(product_response())
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "output"
            expected_payload = upload_products.build_product_master(source).payload_bytes
            with loopback_server(status=200, body=raw_response) as (server, captured):
                return_code, stdout, stderr = self.call_main(
                    source,
                    output_dir,
                    execute=True,
                    environ=self.environment_for(server),
                )

            self.assertEqual(return_code, 0, stderr)
            self.assertEqual(captured["requests"], 1)
            self.assertEqual(captured["body"], expected_payload)
            self.assertIn("product_count=300", stdout)
            self.assertEqual(
                (output_dir / "oeis-response.json").read_bytes(), raw_response
            )
            self.assertTrue((output_dir / "accepted-products-registry.json").is_file())

    def test_execute_partial_response_writes_artifacts_and_returns_nonzero(self):
        response = product_response()
        response["ProductMasterList"][0].update({
            "IsValidated": False,
            "ValidationError": {"ErrorMessage": "private vendor rejection"},
        })
        response["ProductMasterLogs"].update({
            "SuccessRecordCount": 299, "ErrorRecordCount": 1,
        })
        raw_response = response_bytes(response)
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "output"
            with loopback_server(status=200, body=raw_response) as (server, captured):
                return_code, _, stderr = self.call_main(
                    source,
                    output_dir,
                    execute=True,
                    environ=self.environment_for(server),
                )

            self.assertEqual(return_code, 1)
            self.assertEqual(captured["requests"], 1)
            self.assertNotIn("private vendor rejection", stderr)
            self.assertNotIn("ephemeral-cli-key", stderr)
            self.assertTrue((output_dir / "product-master-payload.json").is_file())
            self.assertEqual(
                (output_dir / "oeis-response.json").read_bytes(), raw_response
            )
            registry = json.loads((
                output_dir / "accepted-products-registry.json"
            ).read_text(encoding="utf-8"))
            self.assertEqual(len(registry["products"]), 299)

    def test_execute_malformed_response_writes_no_accepted_claims(self):
        response = product_response()
        response["ProductMasterList"][0]["PRODUCT_CODE"] = "UNKNOWN"
        raw_response = response_bytes(response)
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "output"
            with loopback_server(status=200, body=raw_response) as (server, _):
                return_code, _, stderr = self.call_main(
                    source,
                    output_dir,
                    execute=True,
                    environ=self.environment_for(server),
                )

            self.assertEqual(return_code, 1)
            self.assertNotIn("UNKNOWN", stderr)
            registry = json.loads((
                output_dir / "accepted-products-registry.json"
            ).read_text(encoding="utf-8"))
            self.assertEqual(registry, {"products": {}})
            self.assertTrue((output_dir / "product-master-payload.json").is_file())

    def test_execute_configuration_failure_preserves_offline_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "output"

            return_code, _, stderr = self.call_main(
                source, output_dir, execute=True, environ={}
            )

            self.assertEqual(return_code, 1)
            self.assertTrue((output_dir / "product-master-payload.json").is_file())
            self.assertEqual(
                (output_dir / "accepted-products-registry.json").read_bytes(),
                b'{\n  "products": {}\n}\n',
            )
            self.assertFalse((output_dir / "oeis-response.json").exists())
            self.assertFalse((output_dir / "oeis-product-results.csv").exists())
            self.assertNotIn("OEIS_BASE_URL", stderr)

    def test_execute_http_failure_is_one_attempt_and_preserves_offline_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "output"
            with loopback_server(
                status=500, body=b"private vendor failure"
            ) as (server, captured):
                return_code, _, stderr = self.call_main(
                    source,
                    output_dir,
                    execute=True,
                    environ=self.environment_for(server),
                )

            self.assertEqual(return_code, 1)
            self.assertEqual(captured["requests"], 1)
            self.assertTrue((output_dir / "product-master-payload.json").is_file())
            self.assertEqual(
                (output_dir / "accepted-products-registry.json").read_bytes(),
                b'{\n  "products": {}\n}\n',
            )
            self.assertFalse((output_dir / "oeis-response.json").exists())
            self.assertFalse((output_dir / "oeis-product-results.csv").exists())
            self.assertNotIn("private vendor failure", stderr)
            self.assertNotIn("ephemeral-cli-key", stderr)

    def test_execute_establishes_empty_registry_before_interrupted_publication(self):
        response = product_response()
        response["ProductMasterList"][0].update({
            "IsValidated": False,
            "ValidationError": {"ErrorMessage": "rejected"},
        })
        response["ProductMasterLogs"].update({
            "SuccessRecordCount": 299, "ErrorRecordCount": 1,
        })
        raw_response = response_bytes(response)
        empty_registry = b'{\n  "products": {}\n}\n'
        original_write = upload_products.atomic_write_private
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "output"
            output_dir.mkdir()
            registry_path = output_dir / "accepted-products-registry.json"

            def interrupt_final_registry(path, body, **options):
                if pathlib.Path(path).name == registry_path.name and body != empty_registry:
                    raise OSError("injected final registry failure")
                return original_write(path, body, **options)

            with loopback_server(status=200, body=raw_response) as (server, captured):
                with mock.patch.object(
                    upload_products,
                    "atomic_write_private",
                    side_effect=interrupt_final_registry,
                ):
                    return_code, _, stderr = self.call_main(
                        source,
                        output_dir,
                        execute=True,
                        environ=self.environment_for(server),
                    )

            self.assertEqual(return_code, 1)
            self.assertEqual(captured["requests"], 1)
            self.assertEqual(registry_path.read_bytes(), empty_registry)
            self.assertTrue((output_dir / "oeis-response.json").is_file())
            self.assertNotIn("injected final registry failure", stderr)

    def test_execute_rejects_each_stale_artifact_before_config_or_network(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            with loopback_server(
                status=200, body=response_bytes(product_response())
            ) as (server, captured):
                for artifact_name in (
                    "oeis-response.json",
                    "oeis-product-results.csv",
                    "accepted-products-registry.json",
                ):
                    output_dir = pathlib.Path(directory) / artifact_name
                    output_dir.mkdir()
                    artifact_path = output_dir / artifact_name
                    stale_evidence = (
                        f"private prior evidence for {artifact_name}"
                    ).encode("utf-8")
                    artifact_path.write_bytes(stale_evidence)
                    environment = self.AccessTrackingEnvironment(
                        self.environment_for(server)
                    )

                    return_code, _, stderr = self.call_main(
                        source,
                        output_dir,
                        execute=True,
                        environ=environment,
                    )

                    with self.subTest(artifact_name=artifact_name):
                        self.assertEqual(return_code, 1)
                        self.assertEqual(
                            stderr,
                            "error: upload failed (stale_execution_artifacts)\n",
                        )
                        self.assertEqual(environment.accesses, 0)
                        self.assertEqual(artifact_path.read_bytes(), stale_evidence)
            self.assertEqual(captured["requests"], 0)

    def test_execute_deeply_nested_response_uses_fixed_safe_malformed_path(self):
        deeply_nested = (b"[" * 2000) + b"0" + (b"]" * 2000)
        with tempfile.TemporaryDirectory() as directory:
            source = self.write_valid_catalog(directory)
            output_dir = pathlib.Path(directory) / "output"
            with loopback_server(status=200, body=deeply_nested) as (server, captured):
                return_code, _, stderr = self.call_main(
                    source,
                    output_dir,
                    execute=True,
                    environ=self.environment_for(server),
                )

            self.assertEqual(return_code, 1)
            self.assertEqual(captured["requests"], 1)
            self.assertEqual(stderr, "error: upload failed (malformed_response)\n")
            self.assertEqual(
                (output_dir / "oeis-response.json").read_bytes(), deeply_nested
            )
            registry = json.loads((
                output_dir / "accepted-products-registry.json"
            ).read_text(encoding="utf-8"))
            self.assertEqual(registry, {"products": {}})


if __name__ == "__main__":
    unittest.main()
