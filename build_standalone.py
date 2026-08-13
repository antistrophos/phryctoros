"""build_standalone.py — inline every <script src> into one self-contained HTML.

python build_standalone.py [receive.html ...]   (default: receive.html)

Output: dist/<page>-standalone.html — the sneakernet artifact (spec §9.1): one
file, no network, no folder structure; the file-input decode path needs no
camera and no secure context. Re-run after any src/ change.
"""
import re
import sys
import datetime
import pathlib

ROOT = pathlib.Path(__file__).parent.resolve()


def build(page: str) -> pathlib.Path:
    src_html = (ROOT / "harness" / page).read_text(encoding="utf-8")

    def repl(m: "re.Match[str]") -> str:
        target = (ROOT / "harness" / m.group(1)).resolve()
        js = target.read_text(encoding="utf-8")
        if "</script" in js.lower():
            raise SystemExit(f"refusing: {target.name} contains a literal </script>")
        return f"<script>\n/* inlined: {target.name} */\n{js}\n</script>"

    out = re.sub(r'<script src="([^"]+)"></script>', repl, src_html)
    stamp = f"<!-- single-file build {datetime.date.today().isoformat()} — regenerate with build_standalone.py -->\n"
    out = out.replace("<!DOCTYPE html>", "<!DOCTYPE html>\n" + stamp, 1)

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    dest = dist / page.replace(".html", "-standalone.html")
    dest.write_text(out, encoding="utf-8")
    return dest


if __name__ == "__main__":
    pages = sys.argv[1:] or ["receive.html"]
    for p in pages:
        d = build(p)
        print(f"{d}  ({d.stat().st_size // 1024} KB)")
