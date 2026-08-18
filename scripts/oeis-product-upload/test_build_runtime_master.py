import csv
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT_DIR = pathlib.Path(__file__).parent
MODULE_PATH = SCRIPT_DIR / "build_runtime_master.py"
SPEC = importlib.util.spec_from_file_location("build_runtime_master", MODULE_PATH)
BUILD_RUNTIME_MASTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BUILD_RUNTIME_MASTER
SPEC.loader.exec_module(BUILD_RUNTIME_MASTER)


def historic_registry():
    products = {
        "FMDIF-001": {"uqc": "OTH", "tax_category": "S", "tax_rate": "15.00"},
    }
    for index in range(2, 301):
        products[f"FMDIF-{index:03d}"] = {
            "uqc": "OTH", "tax_category": "S", "tax_rate": "15.00",
        }
    return {"products": products}


def branch_rows():
    return [
        {
            "COMPANY_CODE": "Viva Radix",
            "SOURCE_ERP": "Fynd",
            "SUPPLIER_COUNTRY_CODE_ENGLISH": "SA",
            "BRANCH_CODE": code,
        }
        for code in ("DAMSGH", "JEDSGH", "E014", "MD101")
    ]


class BuildRuntimeMasterTest(unittest.TestCase):
    def write_inputs(self, directory, registry=None, branches=None):
        accepted_registry = directory / "accepted.json"
        branch_master = directory / "branches.csv"
        accepted_registry.write_text(
            json.dumps(registry or historic_registry()), encoding="utf-8"
        )
        with branch_master.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(branch_rows()[0]))
            writer.writeheader()
            writer.writerows(branches or branch_rows())
        return accepted_registry, branch_master

    def test_builds_exact_tax_neutral_runtime_master(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            accepted_registry, branch_master = self.write_inputs(pathlib.Path(temporary_directory))

            result = BUILD_RUNTIME_MASTER.build_runtime_master(accepted_registry, branch_master)

        self.assertEqual(result.value["branches"], ["DAMSGH", "JEDSGH", "E014", "MD101"])
        self.assertEqual(result.value["products"]["FMDIF-001"], {
            "uqc": "OTH",
            "supply_class": "PRIVATE_HEALTHCARE_SERVICE",
            "allowed_zero_rate_reason": "VATEX-SA-HEA",
        })
        self.assertNotIn(b"tax_category", result.json_bytes)
        self.assertNotIn(b"tax_rate", result.json_bytes)
        self.assertEqual(
            getattr(result, "product_code_set_sha256", None),
            "a1ebacc919a3ab839116ada28d324e150eb075141d4c3697434a1445866b7a87",
        )

    def assert_validation_error(self, accepted_registry, branch_master, expected_fragment):
        with self.assertRaises(BUILD_RUNTIME_MASTER.RegistryValidationError) as caught:
            BUILD_RUNTIME_MASTER.build_runtime_master(accepted_registry, branch_master)
        self.assertIn(expected_fragment, " ".join(caught.exception.errors))

    def test_rejects_malformed_or_duplicate_key_accepted_registry(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            accepted_registry, branch_master = self.write_inputs(directory)
            accepted_registry.write_text('{"products":', encoding="utf-8")
            self.assert_validation_error(accepted_registry, branch_master, "valid JSON")

            accepted_registry.write_text(
                '{"products":{},"products":{}}', encoding="utf-8"
            )
            self.assert_validation_error(accepted_registry, branch_master, "duplicate JSON key")

    def test_rejects_unknown_historic_properties_and_wrong_historic_tax_values(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            registry = historic_registry()
            registry["products"]["FMDIF-001"]["description"] = "unapproved"
            accepted_registry, branch_master = self.write_inputs(directory, registry=registry)
            self.assert_validation_error(accepted_registry, branch_master, "unapproved properties")

            registry = historic_registry()
            registry["products"]["FMDIF-001"]["tax_rate"] = "0.00"
            accepted_registry, branch_master = self.write_inputs(directory, registry=registry)
            self.assert_validation_error(accepted_registry, branch_master, "historic tax values")

    def test_rejects_wrong_product_count_and_unsafe_product_codes(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            registry = historic_registry()
            registry["products"].pop("FMDIF-300")
            accepted_registry, branch_master = self.write_inputs(directory, registry=registry)
            self.assert_validation_error(accepted_registry, branch_master, "exactly 300")

            registry = historic_registry()
            product = registry["products"].pop("FMDIF-001")
            registry["products"]["  "] = product
            accepted_registry, branch_master = self.write_inputs(directory, registry=registry)
            self.assert_validation_error(accepted_registry, branch_master, "product code")

    def test_rejects_wrong_branch_headers_identity_and_code_sets(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            accepted_registry, branch_master = self.write_inputs(directory)
            branch_master.write_text("BRANCH_CODE\nDAMSGH\n", encoding="utf-8")
            self.assert_validation_error(accepted_registry, branch_master, "required headers")

            rows = branch_rows()
            rows[0]["COMPANY_CODE"] = "Wrong Company"
            accepted_registry, branch_master = self.write_inputs(directory, branches=rows)
            self.assert_validation_error(accepted_registry, branch_master, "identity")

            rows = branch_rows()
            rows[-1]["BRANCH_CODE"] = "DAMSGH"
            accepted_registry, branch_master = self.write_inputs(directory, branches=rows)
            self.assert_validation_error(accepted_registry, branch_master, "duplicate branch")

            rows = branch_rows()
            rows[-1]["BRANCH_CODE"] = "OTHER"
            accepted_registry, branch_master = self.write_inputs(directory, branches=rows)
            self.assert_validation_error(accepted_registry, branch_master, "branch codes")

    def test_rejects_duplicate_required_csv_headers_before_row_mapping(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            accepted_registry, branch_master = self.write_inputs(directory)
            rows = [
                "COMPANY_CODE,SOURCE_ERP,SUPPLIER_COUNTRY_CODE_ENGLISH,BRANCH_CODE,BRANCH_CODE",
                *[
                    f"Viva Radix,Fynd,SA,{code},{code}"
                    for code in ("DAMSGH", "JEDSGH", "E014", "MD101")
                ],
            ]
            branch_master.write_text("\n".join(rows) + "\n", encoding="utf-8")

            self.assert_validation_error(
                accepted_registry, branch_master, "duplicate required header"
            )

    def test_canonical_bytes_are_deterministic_and_result_is_frozen(self):
        first = BUILD_RUNTIME_MASTER.canonical_json_bytes({"b": ["x"], "a": {"z": 1}})
        second = BUILD_RUNTIME_MASTER.canonical_json_bytes({"a": {"z": 1}, "b": ["x"]})
        self.assertEqual(first, second)
        self.assertEqual(first, b'{"a":{"z":1},"b":["x"]}\n')
        with tempfile.TemporaryDirectory() as temporary_directory:
            accepted_registry, branch_master = self.write_inputs(pathlib.Path(temporary_directory))
            result = BUILD_RUNTIME_MASTER.build_runtime_master(accepted_registry, branch_master)
        with self.assertRaises(AttributeError):
            result.output_sha256 = "changed"

    def test_writes_owner_only_file_without_overwriting_and_rejects_unsafe_directory(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            accepted_registry, branch_master = self.write_inputs(directory)
            result = BUILD_RUNTIME_MASTER.build_runtime_master(accepted_registry, branch_master)
            output_directory = directory / "private-output"
            output_directory.mkdir(mode=0o700)
            output = output_directory / "oeis-masters.json"

            BUILD_RUNTIME_MASTER.write_runtime_master(result, output)

            self.assertEqual(output.read_bytes(), result.json_bytes)
            self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                BUILD_RUNTIME_MASTER.write_runtime_master(result, output)

            unsafe_directory = directory / "unsafe-output"
            unsafe_directory.mkdir(mode=0o700)
            unsafe_directory.chmod(0o755)
            with self.assertRaises(BUILD_RUNTIME_MASTER.RegistryValidationError) as caught:
                BUILD_RUNTIME_MASTER.write_runtime_master(result, unsafe_directory / "oeis-masters.json")
            self.assertIn("unsafe output directory", " ".join(caught.exception.errors))

    def test_creates_every_nested_output_directory_with_owner_only_mode(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            accepted_registry, branch_master = self.write_inputs(directory)
            result = BUILD_RUNTIME_MASTER.build_runtime_master(accepted_registry, branch_master)
            intermediate = directory / "first-private-level"
            leaf = intermediate / "second-private-level"

            BUILD_RUNTIME_MASTER.write_runtime_master(result, leaf / "oeis-masters.json")

            self.assertEqual(os.stat(intermediate).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(leaf).st_mode & 0o777, 0o700)

    def test_cleans_private_temporary_file_when_atomic_publish_fails(self):
        class BrokenOs:
            def __getattr__(self, name):
                return getattr(os, name)

            @staticmethod
            def link(source, destination):
                raise OSError("simulated atomic publish failure")

        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            accepted_registry, branch_master = self.write_inputs(directory)
            result = BUILD_RUNTIME_MASTER.build_runtime_master(accepted_registry, branch_master)
            output = directory / "oeis-masters.json"

            with self.assertRaises(OSError):
                BUILD_RUNTIME_MASTER.write_runtime_master(result, output, os_impl=BrokenOs())

            self.assertFalse(output.exists())
            self.assertEqual(list(directory.glob(".oeis-masters.json.*.tmp")), [])

    def test_cli_writes_only_counts_and_hashes(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            accepted_registry, branch_master = self.write_inputs(directory)
            output_directory = directory / "private-output"
            output_directory.mkdir(mode=0o700)
            output = output_directory / "oeis-masters.json"

            completed = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "--accepted-registry", str(accepted_registry),
                    "--branch-master", str(branch_master),
                    "--output", str(output),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("product_count=300", completed.stdout)
            self.assertIn("branch_count=4", completed.stdout)
            self.assertIn("product_code_set_sha256=", completed.stdout)
            self.assertIn("output_sha256=", completed.stdout)
            self.assertNotIn("FMDIF-001", completed.stdout)
            self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)

            report = output.with_name("oeis-masters.hash-report.json")
            report_value = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(report_value, {
                "accepted_registry_sha256": hashlib.sha256(
                    accepted_registry.read_bytes()
                ).hexdigest(),
                "branch_count": 4,
                "branch_master_sha256": hashlib.sha256(
                    branch_master.read_bytes()
                ).hexdigest(),
                "product_count": 300,
                "product_code_set_sha256": (
                    "a1ebacc919a3ab839116ada28d324e150eb075141d4c3697434a1445866b7a87"
                ),
                "runtime_master_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            })
            self.assertEqual(os.stat(report).st_mode & 0o777, 0o600)
            report_text = report.read_text(encoding="utf-8")
            self.assertNotIn("FMDIF-001", report_text)
            self.assertNotIn("PRIVATE_HEALTHCARE_SERVICE", report_text)


if __name__ == "__main__":
    unittest.main()
