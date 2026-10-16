import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("policy", Path(__file__).with_name("auth-refresh-policy.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class AuthPolicyTests(unittest.TestCase):
    def setUp(self):
        self.now = 2000000
        payload = base64.urlsafe_b64encode(json.dumps({"exp": self.now + 864000}).encode()).decode().rstrip("=")
        self.local = {"tokens": {"account_id": "test-account", "access_token": "test." + payload + ".test"}}
        self.remote = {"expiresAt": self.now - 10, "accountHash": hashlib.sha256(b"test-account").hexdigest(), "now": self.now}

    def result(self):
        return policy.decide(self.local, self.remote, self.now)

    def test_expired_same_account_can_sync(self):
        self.assertEqual(self.result()["state"], "sync-needed")

    def test_expiring_in_one_hour_can_sync(self):
        self.remote["expiresAt"] = self.now + 3599
        self.assertEqual(self.result()["state"], "sync-needed")

    def test_fresh_remote_does_not_sync(self):
        self.remote["expiresAt"] = self.now + 7200
        self.assertEqual(self.result()["state"], "fresh")

    def test_different_account_cannot_sync(self):
        self.remote["accountHash"] = "different"
        self.assertEqual(self.result()["reason"], "account-mismatch-or-unknown")

    def test_unknown_account_cannot_sync(self):
        del self.remote["accountHash"]
        self.assertEqual(self.result()["state"], "blocked")

    def test_unknown_expiry_cannot_sync(self):
        self.remote["expiresAt"] = None
        self.assertEqual(self.result()["reason"], "expiry-unavailable")

    def test_non_jwt_token_cannot_sync(self):
        self.local["tokens"]["access_token"] = "opaque"
        self.assertEqual(self.result()["state"], "blocked")

    def test_api_key_credentials_cannot_sync(self):
        self.local = {"OPENAI_API_KEY": "not-a-real-key"}
        self.assertEqual(self.result()["state"], "blocked")

    def test_expired_local_cannot_sync(self):
        payload = base64.urlsafe_b64encode(json.dumps({"exp": self.now - 1}).encode()).decode()
        self.local["tokens"]["access_token"] = "test." + payload + ".test"
        self.assertEqual(self.result()["reason"], "no-newer-valid-local-token")

    def test_clock_skew_cannot_sync(self):
        self.remote["now"] += 301
        self.assertEqual(self.result()["reason"], "clock-skew")

    def test_same_expiring_token_is_not_copied_repeatedly(self):
        self.remote["expiresAt"] = self.now + 60
        payload = base64.urlsafe_b64encode(json.dumps({"exp": self.remote["expiresAt"]}).encode()).decode()
        self.local["tokens"]["access_token"] = "test." + payload + ".test"
        self.assertEqual(self.result()["state"], "blocked")

    def test_output_contains_no_credentials(self):
        result = json.dumps(self.result())
        self.assertNotIn("test-account", result)
        self.assertNotIn("access_token", result)
        self.assertNotIn(self.local["tokens"]["access_token"], result)


if __name__ == "__main__":
    unittest.main()
