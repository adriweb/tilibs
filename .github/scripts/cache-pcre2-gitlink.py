#!/usr/bin/env python3
"""Cache PCRE2's GitHub API metadata using the CI job's authenticated gh CLI."""

import json
import os
from pathlib import Path
import subprocess


root = Path(os.environ["VCPKG_ROOT"])
port = root / "ports" / "pcre2"
if "https://api.github.com/repos/PCRE2Project/pcre2/contents/deps/sljit" in (port / "portfile.cmake").read_text():
    version = json.loads((port / "vcpkg.json").read_text())["version"]
    tag = f"pcre2-{version}"
    response = subprocess.check_output([
        "gh", "api", "--method", "GET",
        f"repos/PCRE2Project/pcre2/contents/deps/sljit?ref={tag}",
    ])
    # gh emits compact JSON. Match the API's ordinary, indented representation;
    # vcpkg still checks these exact bytes against the port's pinned SHA-512.
    data = (json.dumps(json.loads(response), indent=2) + "\n").encode("utf-8")
    destination = root / "downloads" / f"pcre2-{tag}-sljit-gitlink.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    print(f"Cached authenticated PCRE2 {version} submodule metadata")
