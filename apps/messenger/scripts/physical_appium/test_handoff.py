import copy
import hashlib
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from . import handoff
except ImportError:  # also support unittest discover -s physical_appium
    import handoff


# Fictional test data only. The helper is called with private input on stdin.
FIXTURE_EMAILS = {"A": "qa-fixture-a@example.org", "B": "qa-fixture-b@example.org"}
FIXTURE_CODES = {"A": "00000001", "B": "01234567"}
HELPER = Path(__file__).resolve().parent.parent / "live-input-envelope.mjs"


class PrivateHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.private, self.public = self.root / "private", self.root / "public"
        self.sha = "9" * 40
        self.email_policy = patch.dict(os.environ, {
            "VELLIVEX_QA_EMAIL_SHA256_" + r: hashlib.sha256(addr.encode()).hexdigest()
            for r, addr in FIXTURE_EMAILS.items()})
        self.email_policy.start()
        self.addCleanup(self.email_policy.stop)
        self.session = handoff.PrivateHandoff(self.private, self.public, "123456", 2, self.sha)
        self.d = self.session.prepare()
        self.fake_ids = {"A":"synthetic-first-android-id", "B":"synthetic-second-android-id"}
        self.addCleanup(self.session.close)

    def bind(self):
        return self.session.bind_physical("a"*64, "b"*64, self.fake_ids)

    def envelopes(self, purpose, vals, timestamp=None):
        now = int(time.time()) if timestamp is None else timestamp
        # No shell or instance key on disk. Helper reads only the public descriptor.
        script = """
        import { readFileSync } from 'node:fs';
        import { seal } from %s;
        const q=JSON.parse(readFileSync(0,'utf8'));
        const result={};
        for(const role of ['A','B']) result[role]=seal(q.descriptor,role,q.purpose,{[q.purpose]:q.values[role]},q.time);
        process.stdout.write(JSON.stringify(result));
        """ % json.dumps(HELPER.as_uri())
        args = {"descriptor": self.d, "purpose":purpose, "values":vals, "time":now}
        p = subprocess.run(["node","--input-type=module","-e",script], input=json.dumps(args),
                           text=True, capture_output=True, check=False)
        self.assertEqual(p.returncode, 0, "Reviewed envelope helper rejected synthetic fixture")
        return json.loads(p.stdout)

    def ready(self):
        self.bind()
        self.session.read_emails(self.envelopes("email",FIXTURE_EMAILS)).clear()
        return self.session.publish_ready({"A":int(time.time()),"B":int(time.time())})

    def test_node_to_python_roundtrip_two_roles_without_writing_values_or_private_key(self):
        binding=self.bind()
        emails=self.session.read_emails(self.envelopes("email",FIXTURE_EMAILS))
        self.assertEqual(emails,FIXTURE_EMAILS)
        self.assertNotIn(FIXTURE_EMAILS["A"],repr(emails))
        t=int(time.time())
        ready=self.session.publish_ready({"A":t,"B":t})
        code_envelopes=self.envelopes("code",FIXTURE_CODES)
        values=self.session.read_pair(code_envelopes)
        self.assertEqual(values,FIXTURE_CODES)
        self.assertEqual(str(values),"<private two-phone input>")
        self.assertEqual(ready["conservative_code_deadline"],t+600)
        self.assertEqual(binding["sessions"],[hashlib.sha256(self.fake_ids[r].encode()).hexdigest() for r in ("A","B")])
        self.assertEqual(set(p.name for p in self.public.iterdir()),{"public-key.json","physical-attestation.json","code-handoff.json"})
        self.assertEqual(list(self.private.iterdir()),[])
        all_public=" ".join(p.read_text() for p in self.public.iterdir())
        for private in [*FIXTURE_CODES.values(),*FIXTURE_EMAILS.values(),*self.fake_ids.values(),"PRIVATE KEY"]:
            self.assertNotIn(private,all_public)
        with self.assertRaises(handoff.HandoffError): self.session.read_pair(code_envelopes)

    def test_wrong_identity_or_role_is_rejected_before_ready(self):
        self.bind()
        e=self.envelopes("email",dict(FIXTURE_EMAILS,B="other@example.org"))
        with self.assertRaises(handoff.HandoffError): self.session.read_emails(e)
        with self.assertRaises(handoff.HandoffError): self.session.publish_ready({"A":int(time.time()),"B":int(time.time())})
        e=self.envelopes("email",FIXTURE_EMAILS)
        with self.assertRaises(handoff.HandoffError): self.session.read_emails({"A":e["B"],"B":e["A"]})
        self.assertEqual(self.session.read_emails(e),FIXTURE_EMAILS)

    def test_rejects_modified_and_wrong_run_envelopes_without_consuming_valid_role(self):
        self.ready()
        original=self.envelopes("code",FIXTURE_CODES)
        variants = []
        for key in ("role","purpose","issued_at","expires_at"):
            v=copy.deepcopy(original)
            if key=="role": v["B"]["metadata"][key]="A"
            elif key=="purpose": v["B"]["metadata"][key]="email"
            else: v["B"]["metadata"][key]-=1
            variants.append(v)
        for key in ("tag","iv","encrypted_key","ciphertext","session_id","key_id","run_id","head_sha"):
            v=copy.deepcopy(original); v["B"][key]=("x" if v["B"][key][0]!="x" else "y")+v["B"][key][1:];variants.append(v)
        v=copy.deepcopy(original);v["B"]["run_attempt"]=True;variants.append(v)
        for invalid in variants:
            with self.assertRaises(handoff.HandoffError) as exc: self.session.read_pair(invalid)
            self.assertNotIn(FIXTURE_CODES["B"], str(exc.exception))
        self.assertEqual(self.session.read_pair(original),FIXTURE_CODES)

    def test_private_directory_cannot_overlap_published_artifacts(self):
        for directory in [self.public,self.public/"secrets",self.root]:
            with self.assertRaises(handoff.HandoffError):
                handoff.PrivateHandoff(directory,self.public,"123456",1,self.sha)

    def test_missing_or_duplicate_private_role_pins_fail_closed(self):
        for digest in ("", os.environ["VELLIVEX_QA_EMAIL_SHA256_B"]):
            with patch.dict(os.environ, {"VELLIVEX_QA_EMAIL_SHA256_A": digest}):
                with self.assertRaises(handoff.HandoffError):
                    handoff.PrivateHandoff(self.private,self.public,"123456",2,self.sha)

    def test_retired_and_expired_code_screens_fail_closed(self):
        self.ready()
        e=self.envelopes("code",FIXTURE_CODES)
        with patch("time.time",return_value=time.time()+601):
            with self.assertRaises(handoff.HandoffError): self.session.read_pair(e)
        self.session.close()
        with self.assertRaises(handoff.HandoffError): self.session.read_pair(e)

    def test_cannot_reuse_one_phone_for_both_roles_or_overwrite_artifacts(self):
        with self.assertRaises(handoff.HandoffError):
            self.session.bind_physical("a"*64, "b"*64, dict(self.fake_ids,B=self.fake_ids["A"]))
        self.bind()
        other=handoff.PrivateHandoff(self.private,self.public,"123456",2,self.sha)
        with self.assertRaises(FileExistsError): other.prepare()

if __name__=="__main__":
    unittest.main()
