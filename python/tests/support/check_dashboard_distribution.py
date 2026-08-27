from __future__ import annotations

import io
import json
import sys
import tarfile
import zipfile
from pathlib import Path


def dashboard_files(distribution: Path) -> tuple[bytes, bytes]:
    if distribution.suffix == ".whl":
        with zipfile.ZipFile(distribution) as archive:
            manifest_name = next(
                name for name in archive.namelist() if name.endswith("/dashboard/bundle.json")
            )
            manifest = json.loads(archive.read(manifest_name))
            bundle_name = f"{Path(manifest_name).parent.as_posix()}/{manifest['archive']}"
            return archive.read(manifest_name), archive.read(bundle_name)

    with tarfile.open(distribution, "r:gz") as archive:
        manifest_name = next(
            name
            for name in archive.getnames()
            if name.endswith("/src/workhorse/dashboard/bundle.json")
        )
        manifest_file = archive.extractfile(manifest_name)
        if manifest_file is None:
            raise AssertionError(f"{distribution} has no readable dashboard manifest")
        manifest_bytes = manifest_file.read()
        manifest = json.loads(manifest_bytes)
        bundle_name = f"{Path(manifest_name).parent.as_posix()}/{manifest['archive']}"
        bundle_file = archive.extractfile(bundle_name)
        if bundle_file is None:
            raise AssertionError(f"{distribution} has no readable dashboard archive")
        return manifest_bytes, bundle_file.read()


def check(distribution: Path) -> None:
    _manifest, bundle = dashboard_files(distribution)
    with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as archive:
        if "app/THIRD_PARTY_NOTICES.txt" not in archive.getnames():
            raise AssertionError(f"{distribution} dashboard archive omits third-party notices")


if __name__ == "__main__":
    for argument in sys.argv[1:]:
        check(Path(argument))
