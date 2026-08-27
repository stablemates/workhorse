from __future__ import annotations

import importlib.resources
import json
import tarfile


def test_dashboard_bundle_is_available_to_importlib_resources() -> None:
    dashboard = importlib.resources.files("workhorse").joinpath("dashboard")
    manifest = json.loads(dashboard.joinpath("bundle.json").read_text())
    bundle = dashboard.joinpath(manifest["archive"])
    assert bundle.is_file()
    with (
        importlib.resources.as_file(bundle) as archive_path,
        tarfile.open(archive_path, "r:gz") as archive,
    ):
        names = set(archive.getnames())
    assert {"app/index.html", "app/THIRD_PARTY_NOTICES.txt", "login.html"} <= names
