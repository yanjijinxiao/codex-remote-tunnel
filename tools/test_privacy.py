import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("privacy", Path(__file__).with_name("check-privacy.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivacyTests(unittest.TestCase):
    def test_loopback_and_templates_are_allowed(self):
        self.assertEqual(module.problems("127.0.0.1 $HOME __HOME__ example.invalid"), [])

    def test_endpoint_literals_are_rejected_without_repeating_them(self):
        address = ".".join(["10", "20", "30", "40"])
        findings = module.problems(address)
        self.assertIn("non-loopback IP literal", findings)
        self.assertNotIn(address, " ".join(findings))

    def test_home_paths_are_rejected(self):
        for prefix in ["Users", "home"]:
            self.assertIn("personal home path", module.problems("/" + prefix + "/sample"))

    def test_personal_email_is_rejected_but_anonymous_identity_is_allowed(self):
        self.assertIn("email address", module.problems("person" + "@" + "company.example"))
        self.assertEqual(module.problems("maintainer@example.invalid"), [])

    def test_credential_shapes_are_rejected(self):
        self.assertIn("token literal", module.problems("ghp_" + "a" * 36))
        self.assertIn("private key", module.problems("-----BEGIN " + "PRIVATE KEY-----"))


if __name__ == "__main__":
    unittest.main()
