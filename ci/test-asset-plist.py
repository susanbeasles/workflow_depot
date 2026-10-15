"""asset_scan: Apple's public plist DOCTYPE passes; any other DOCTYPE, ENTITY or internal subset stays critical."""
import json, pathlib, subprocess, sys, tempfile

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "security-assurance/.github/scripts/asset_scan.py"
APPLE = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
cases = {
    "ok.plist": f'<?xml version="1.0"?>\n{APPLE}\n<plist version="1.0"><dict/></plist>\n',
    "subset.plist": APPLE.replace('.dtd">', '.dtd" [<!ENTITY x "y">]>') + "\n<plist/>\n",
    "entity.plist": f"{APPLE}\n<!ENTITY a \"b\">\n<plist/>\n",
    "double.plist": f'{APPLE}\n<!DOCTYPE plist SYSTEM "file:///etc/passwd">\n<plist/>\n',
    "other.xml": '<!DOCTYPE foo SYSTEM "http://evil/x.dtd">\n<foo/>\n',
}
with tempfile.TemporaryDirectory() as d:
    for name, body in cases.items():
        pathlib.Path(d, name).write_text(body)
    out = pathlib.Path(d, "out.json")
    subprocess.run([sys.executable, "-I", str(SCRIPT), "--root", d, "--out", str(out)], check=True, capture_output=True)
    hits = {pathlib.Path(i["path"]).name for i in json.loads(out.read_text())["items"] if i["rule"] == "XML-DTD"}
    assert hits == set(cases) - {"ok.plist"}, hits
print("OK")
