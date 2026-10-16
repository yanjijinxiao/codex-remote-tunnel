import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("render", Path(__file__).with_name("render-launchd.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RenderTests(unittest.TestCase):
    def test_structured_values_are_preserved(self):
        result = module.replace_home({"flag": True, "args": ["__HOME__/bin/run", 10]}, "/tmp/example")
        self.assertEqual(result, {"flag": True, "args": ["/tmp/example/bin/run", 10]})

    def test_all_templates_render_to_private_temporary_files(self):
        source = Path(__file__).resolve().parent.parent / "launchd"
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            module.render(source, target, Path("/tmp/example"))
            files = list(target.glob("*.plist"))
            self.assertEqual(len(files), 3)
            for file in files:
                with file.open("rb") as stream:
                    self.assertIsInstance(plistlib.load(stream), dict)
                self.assertNotIn("__HOME__", file.read_text())
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
