"""Synthetic Maildir contract checks. Run with python3 -B scripts/test_maildir_index_sweep.py."""
import datetime as dt
import io
import math
import os
from pathlib import Path
import runpy
import struct
import tempfile
import unittest
from unittest import mock

HELPER = runpy.run_path(str(Path(__file__).with_name("maildir-index-sweep")))
collect = HELPER["collect"]
day = HELPER["day"]
indexed_fts_uids = HELPER["indexed_fts_uids"]
parse_uidlist = HELPER["parse_uidlist"]
read_xapian_stats = HELPER["read_xapian_stats"]
sortable_unserialise = HELPER["sortable_unserialise"]
GLASS_MAGIC = HELPER["GLASS_MAGIC"]


def _pack_uint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            break
    return bytes(out)


def _store_first(logical):
    bit7 = (logical >> 7) & 1
    bit6 = (logical >> 6) & 1
    bit5 = (logical >> 5) & 1
    stored6 = bit6 ^ bit7
    stored5 = bit5 ^ bit6 ^ bit7
    return (bit7 << 7) | (stored6 << 6) | (stored5 << 5) | (logical & 0x1F)


def sortable_serialise(value):
    """Positive-only writer used to build synthetic value-slot bounds."""
    if value == 0:
        return b"\x80"
    mantissa, exponent = math.frexp(value)
    signed = exponent - 8
    exponent_negative = signed < 0
    magnitude = -signed if exponent_negative else signed
    word = int(round(mantissa * float(1 << 27)))
    payload = word & 0x03FFFFFF
    top2 = (payload >> 24) & 0x03
    rest = payload & 0xFFFFFF
    tail = bytes([(rest >> 16) & 0xFF, (rest >> 8) & 0xFF, rest & 0xFF])
    if magnitude <= 7:
        field = magnitude ^ (0x07 if exponent_negative else 0)
        logical = 0x80 | (0x40 if exponent_negative else 0) | 0x20 | ((field & 7) << 2) | top2
        return bytes([_store_first(logical)]) + tail
    field = magnitude ^ (0x07FF if exponent_negative else 0)
    logical = 0x80 | (0x40 if exponent_negative else 0) | ((field >> 6) & 0x1F)
    second = ((field & 0x3F) << 2) | top2
    return bytes([_store_first(logical), second]) + tail


def _glass_db(directory, doccount, level, last_uid, freq):
    block = 2048
    serial = sortable_serialise(last_uid)
    tag = _pack_uint(freq) + _pack_uint(len(serial)) + serial
    key = b"\x00\xd0\x01"
    item_len = len(key) + len(tag)
    item = struct.pack(">H", 0x4000 | item_len) + bytes([len(key)]) + key + tag
    leaf = bytearray(block)
    leaf[4] = 0
    struct.pack_into(">H", leaf, 9, 13)
    struct.pack_into(">H", leaf, 11, 64)
    leaf[64:64 + len(item)] = item
    chunks = [bytes(leaf)]
    root = 0
    if level:
        branch = bytearray(block)
        branch[4] = level
        # Put the first BItem at the very end of the block (block - 7), matching real Xapian Glass,
        # and a second BItem with separator key <= \x00\xd0\x01 pointing to leaf block 0.
        first_off = block - 7
        second_off = block - 17
        struct.pack_into(">H", branch, 9, 15)
        struct.pack_into(">H", branch, 11, first_off)
        struct.pack_into(">H", branch, 13, second_off)
        struct.pack_into(">I", branch, first_off, 99)  # leftmost child (before separator)
        struct.pack_into(">I", branch, second_off, 0)  # child for keys >= \x00\xc0
        branch[second_off + 4] = 2
        branch[second_off + 5:second_off + 7] = b"\x00\xc0"
        chunks.append(bytes(branch))
        root = 1
    body = bytearray(_pack_uint(1))
    tables = [(root, (level << 2), doccount, 1)] + [(0, 1, 0, 0)] * 5
    for table_root, val, entries, bs_raw in tables:
        body += _pack_uint(table_root)
        body += _pack_uint(val)
        body += _pack_uint(entries)
        body += _pack_uint(bs_raw)
        body += _pack_uint(0)
        body += _pack_uint(0)
    body += _pack_uint(doccount)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "iamglass").write_bytes(GLASS_MAGIC + (b"\x00" * 16) + bytes(body))
    (directory / "postlist.glass").write_bytes(b"".join(chunks))
    (directory / "termlist.glass").write_bytes(b"")
    (directory / "docdata.glass").write_bytes(b"")


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

    def test_day_accepts_optional_time(self):
        self.assertEqual(day("2025-03-01"), dt.datetime(2025, 3, 1))
        self.assertEqual(day("2025-03-01 12:30"), dt.datetime(2025, 3, 1, 12, 30))
        self.assertEqual(day("2025-03-01T12:30:45"), dt.datetime(2025, 3, 1, 12, 30, 45))
        with self.assertRaisesRegex(ValueError, "date"):
            day("2025-03-01T12")


class UidlistFastPathTest(WindowTest):
    def write_uidlist(self, names):
        lines = ["3 V1 N5 G" + ("a" * 32)]
        for uid, name in enumerate(names, start=1):
            lines.append("{0} :{1}".format(uid, name))
        (self.folder.parent / "dovecot-uidlist").write_text("\n".join(lines) + "\n")

    def test_uidlist_fast_path_skips_out_of_window_stats(self):
        names = ["before", "hit:2,S", "midnight", "after"]
        self.write_uidlist(names)
        guid, _next, max_uid, uid_to_base, base_to_uid = parse_uidlist(
            self.folder.parent / "dovecot-uidlist")
        self.assertEqual(guid, "a" * 32)
        self.assertEqual(max_uid, 4)
        self.assertEqual(uid_to_base[4], "after")
        self.assertEqual(base_to_uid["hit"], 2)
        statted = []
        real_stat = Path.stat

        def tracking(path, *args, **kwargs):
            if path.name in names:
                statted.append(path.name)
            return real_stat(path, *args, **kwargs)

        with mock.patch.object(Path, "stat", tracking):
            rows = self.scan({"hit", "midnight", "after", "expunged"})
        self.assertEqual(set(rows), {os.fsencode(self.folder / n) for n in ("hit:2,S", "midnight")})
        self.assertNotIn("before", statted)
        self.assertIn("after", statted)

        with self.assertRaisesRegex(ValueError, "coverage"):
            self.scan({"hit", "midnight"})

        extra = self.folder / "extra"
        extra.touch()
        os.utime(extra, ns=(self.lo + 2_000_000, self.lo + 2_000_000))
        with self.assertRaisesRegex(ValueError, "coverage"):
            self.scan({"before", "hit", "midnight", "after"})


class XapianTest(unittest.TestCase):
    def setUp(self):
        WindowTest.setUp(self)
        names = ["before", "hit:2,S", "midnight", "after"]
        lines = ["3 V1 N5 G" + ("b" * 32)]
        for uid, name in enumerate(names, start=1):
            lines.append("{0} :{1}".format(uid, name))
        (self.folder.parent / "dovecot-uidlist").write_text("\n".join(lines) + "\n")
        self.db = self.folder.parent.parent / "xapian-indexes" / ("db_" + ("b" * 32))
        _glass_db(self.db, doccount=4, level=1, last_uid=4, freq=4)

    def test_sortable_round_trip_and_direct_stats(self):
        for uid in (1, 2, 4, 20, 1000, 1_000_000):
            raw = sortable_unserialise(sortable_serialise(uid))
            self.assertEqual(int(round(raw)), uid)
        doccount, freq, last = read_xapian_stats(self.db)
        self.assertEqual((doccount, freq, last), (4, 4, 4))

    def _collect(self, uids, first="2025-03-01", last="2025-03-02"):
        return collect(
            self.root, "reports@example.test", first, last, [self.rel],
            lambda *_args: self.fail("date lookup used"),
            fts=("full_text", (), ("590550",)),
            fts_lookup=lambda *_args: set(uids),
        )

    def test_xapian_stats_and_fts_collect(self):
        rows = self._collect({2})
        self.assertEqual(rows, [os.fsencode(self.folder / "hit:2,S")])
        filtered = self._collect({1, 2})
        self.assertEqual(filtered, [os.fsencode(self.folder / "hit:2,S")])
        undated = collect(
            self.root, "reports@example.test", "", "", [self.rel],
            fts=("headers", ("subject",), ("invoice",)),
            fts_lookup=lambda *_args: {2, 4},
        )
        self.assertEqual(set(undated), {
            os.fsencode(self.folder / "hit:2,S"),
            os.fsencode(self.folder / "after"),
        })

        _glass_db(self.db, doccount=4, level=1, last_uid=2, freq=4)
        with self.assertRaisesRegex(ValueError, "xapian coverage"):
            self._collect({2})

        (self.db / "iamglass").unlink()
        with self.assertRaisesRegex(ValueError, "xapian coverage"):
            self._collect({2})
        _glass_db(self.db, doccount=4, level=0, last_uid=4, freq=4)
        (self.db / "postlist.glass").unlink()
        with self.assertRaisesRegex(ValueError, "xapian coverage"):
            self._collect({2})


class FtsArgsTest(unittest.TestCase):
    def capture(self, scope, fields, tokens, out):
        seen = []

        class Proc(object):
            def __init__(self):
                self.stdout = io.BytesIO(out)

            def poll(self):
                return 0

            def wait(self):
                return 0

            def kill(self):
                return None

        def popen(argv, **_kwargs):
            seen.append(argv)
            return Proc()

        since = dt.datetime(2025, 3, 1)
        before = dt.datetime(2025, 3, 2)
        guid = "ab" * 16
        with mock.patch("subprocess.Popen", popen):
            uids = indexed_fts_uids(
                "reports@example.test", guid, since, before, scope, fields, tokens)
        return seen[0], uids

    def test_indexed_fts_uids_builds_doveadm_search(self):
        guid = "ab" * 16
        text_args, uids = self.capture("full_text", (), ("590550",), "{0} 9\n".format(guid).encode())
        self.assertEqual(text_args[:8], [
            "/usr/bin/doveadm", "-o", "plugin/fts_enforced=yes", "search", "-u",
            "reports@example.test", "mailbox-guid", guid,
        ])
        self.assertEqual(text_args[8:], ["since", "2025-02-28", "before", "2025-03-04", "text", "590550"])
        self.assertEqual(uids, {9})

        one, _uids = self.capture("headers", ("subject",), ("invoice",), b"")
        self.assertEqual(one[-3:], ["header", "subject", "invoice"])
        self.assertNotIn("(", one)

        many, _uids = self.capture("headers", ("from", "subject"), ("invoice",), b"")
        self.assertEqual(many[-9:], [
            "(", "header", "from", "invoice", "OR", "header", "subject", "invoice", ")",
        ])

        with self.assertRaisesRegex(ValueError, "fts search error"):
            self.capture("full_text", (), ("590550",), b"not-a-hit\n")


if __name__ == "__main__":
    unittest.main()
