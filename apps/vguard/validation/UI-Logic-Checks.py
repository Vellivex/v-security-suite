#!/usr/bin/env python3
"""Exercise the production CSV field encoder against Python's independent CSV parser.

The Java method is extracted verbatim from MainActivity.java, not reimplemented.
This test does not claim to verify Android lifecycle or native widget behaviour.
"""
import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import random
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / "app/src/main/java/app/vguard/firewall/MainActivity.java").read_text()
start = source.index("    private static String csvCell(")
opening = source.index("{", start)
depth = 1
end = opening + 1
while depth:
    if source[end] == "{":
        depth += 1
    elif source[end] == "}":
        depth -= 1
    end += 1
method = source[start:end]

cases = [
    None, "", "Selected app", "203.0.113.15", "2001:db8:0:0:0:0:0:15", "TCP", "UDP",
    "=1+1", "+SUM(1,2)", "-1+2", "@SUM(A1:A4)", "\t=1+1",
    '=HYPERLINK("https://example.invalid","open")',
    'quotes "and", commas', "first\r\nsecond", "first\nsecond", "first\rsecond",
    "plain,=1+1", '"\r\n=1+1', "日本語 · café · naïve", "[2001:db8::4]:443",
]
rng = random.Random(61010)
alphabet = 'abcXYZ0123456789\r\n\t,"=+-@ .:é😀'
cases.extend("".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 160))) for _ in range(300))

java_source = '''import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
public final class CsvFieldProbe {
    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            String value = line.equals("!") ? null : new String(Base64.getDecoder().decode(line), StandardCharsets.UTF_8);
            System.out.println(Base64.getEncoder().encodeToString(csvCell(value).getBytes(StandardCharsets.UTF_8)));
        }
    }
''' + method + "\n}\n"

with tempfile.TemporaryDirectory(prefix="vguard-csv-test-") as task_tmp:
    work = Path(task_tmp)
    probe = work / "CsvFieldProbe.java"
    probe.write_text(java_source)
    subprocess.run(["java", "-m", "jdk.compiler/com.sun.tools.javac.Main", "-encoding", "UTF-8", str(probe)], check=True)
    encoded_input = "\n".join("!" if case is None else base64.b64encode(case.encode()).decode() for case in cases) + "\n"
    result = subprocess.run(["java", "-cp", str(work), "CsvFieldProbe"], input=encoded_input,
                            text=True, capture_output=True, check=True)
    fields = [base64.b64decode(value).decode() for value in result.stdout.splitlines()]

assert len(fields) == len(cases)
protected = 0
for number, (case, encoded) in enumerate(zip(cases, fields)):
    parsed = list(csv.reader(io.StringIO(encoded + "\r\n", newline=""), strict=True))
    assert len(parsed) == 1 and len(parsed[0]) == 1, (number, "CSV field escaped its row/column")
    original = "" if case is None else case.replace("\r", " ").replace("\n", " ")
    if original.startswith(("=", "+", "-", "@", "\t")):
        assert parsed[0][0].startswith("'"), (number, "Formula-leading field was not neutralised")
        assert parsed[0][0][1:] == original
        protected += 1
    else:
        assert parsed[0][0] == original, (number, "Text changed unexpectedly")

report = {
    "scope": "Production CSV field encoder only; independent Python CSV parser",
    "cases_passed": len(cases),
    "formula_leading_cases_neutralised": protected,
    "single_row_single_column_escape_check": "passed",
    "unicode_quotes_commas_cr_lf_null_checks": "passed",
    "production_method_sha256": hashlib.sha256(method.encode()).hexdigest(),
    "android_lifecycle_runtime_tested": False,
    "spreadsheet_application_runtime_tested": False,
}
print(json.dumps(report, indent=2))
