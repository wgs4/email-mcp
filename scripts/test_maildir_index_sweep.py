"""Synthetic Maildir contract checks. Run with python3 -B scripts/test_maildir_index_sweep.py."""
import datetime as dt
import os
from pathlib import Path
import runpy
import tempfile
import unittest

collect = runpy.run_path(str(Path(__file__).with_name("maildir-index-sweep")))["collect"]


class WindowTest(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.root = Path(workspace.name).resolve()
        self.rel = "example.test/reports/Maildir/.Archive/cur"
        self.folder = self.root / self.rel
        self.folder.mkdir(parents=True)
        (self.folder.parent / "dovecot-uidlist").write_text("3 V1 N4 G" + "a" * 32 + "\n")
        self.lo = int(dt.datetime(2025, 3, 1).timestamp()) * 10**9
        self.hi = int(dt.datetime(2025, 3, 2).timestamp()) * 10**9
        for name, moment in [("before", self.lo), ("hit:2,S", self.lo + 1_000_000),
                             ("midnight", self.hi), ("after", self.hi + 1_000_000)]:
            p = self.folder / name
            p.touch()
            os.utime(p, ns=(moment, moment))

    def scan(self, names):
        return collect(self.root, "reports@example.test", "2025-03-01", "2025-03-02",
                       [self.rel], lambda *_: names)

    def test_delivery_date_boundaries_and_flag_suffix(self):
        self.assertEqual(set(self.scan({"hit", "midnight", "expunged"})),
                         {os.fsencode(self.folder / n) for n in ("hit:2,S", "midnight")})

    def test_unused_folder_without_uidlist(self):
        rel = "example.test/reports/Maildir/.Unused/new"
        (self.root / rel).mkdir(parents=True)
        rows = collect(self.root, "reports@example.test", "2025-03-01", "", [rel],
                       lambda *_: self.fail("unused folder reached Dovecot"))
        self.assertEqual(rows, [])

    def test_missing_indexed_delivery(self):
        with self.assertRaisesRegex(ValueError, "coverage"):
            self.scan({"hit"})

    def test_missing_index_header(self):
        (self.folder.parent / "dovecot-uidlist").write_text("2 V1\n")
        with self.assertRaisesRegex(ValueError, "format"):
            self.scan(set())

    def test_changed_mailbox(self):
        def lookup(*_):
            (self.folder / "delivery").touch()
            return {"hit", "midnight", "delivery", "after"}
        with self.assertRaisesRegex(ValueError, "changed"):
            collect(self.root, "reports@example.test", "2025-03-01", "", [self.rel], lookup)

    def test_cross_mailbox_folder(self):
        with self.assertRaisesRegex(ValueError, "folder"):
            collect(self.root, "other@example.test", "2025-03-01", "", [self.rel])


if __name__ == "__main__":
    unittest.main()
