"""Build and install the Python distributions the way a release does."""

from __future__ import annotations

import subprocess
from pathlib import Path

REPOSITORY = Path(__file__).parents[2]
BUILD_CONSTRAINTS = REPOSITORY / "python" / "build-constraints.txt"


def install_distribution(
    artifact: Path,
    interpreter: Path,
    extras: str | None,
    scratch: Path,
    constraints: Path = BUILD_CONSTRAINTS,
) -> None:
    """Install a wheel, or an sdist through a wheel built under the pinned backend.

    Installing an sdist builds a wheel from it. uv.lock does not cover that build's
    backend, so the build reads the hash-pinned constraints like every other build.
    """
    if artifact.name.endswith(".tar.gz"):
        wheel_directory = scratch / f"{interpreter.parents[1].name}-wheel"
        subprocess.run(
            [
                "uv",
                "build",
                str(artifact),
                "--wheel",
                "--build-constraints",
                str(constraints),
                "--require-hashes",
                "--out-dir",
                str(wheel_directory),
            ],
            check=True,
            cwd=REPOSITORY,
        )
        artifact = next(wheel_directory.glob("*.whl"))
    subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(interpreter),
            f"{artifact}[{extras}]" if extras else str(artifact),
        ],
        check=True,
        cwd=REPOSITORY,
    )
