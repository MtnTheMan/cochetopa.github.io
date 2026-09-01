#!/usr/bin/env python3
"""Fail a public build if the Cochetopa course shell is incomplete or leaks private data."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2] if ".github" in Path(__file__).parts else Path(__file__).resolve().parent


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"COURSE PUBLIC RELEASE VALIDATION FAILED: {message}")


def main() -> int:
    required = [
        ROOT / "course" / "index.md",
        ROOT / "_layouts" / "course_app.html",
        ROOT / "assets" / "course" / "app.js",
        ROOT / "assets" / "course" / "auth.js",
        ROOT / "assets" / "course" / "app.css",
        ROOT / "assets" / "course" / "data" / "course-catalog.json",
        ROOT / "assets" / "course" / "data" / "public-media.json",
        ROOT / "assets" / "course" / "data" / "runtime-config.json",
        ROOT / "supabase" / "migrations" / "202608310001_course_schema.sql",
        ROOT / "supabase" / "migrations" / "202609010002_nonvisual_grading.sql",
    ]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.is_file()]
    require(not missing, f"missing files: {', '.join(missing)}")

    catalog = json.loads((ROOT / "assets" / "course" / "data" / "course-catalog.json").read_text(encoding="utf-8"))
    media = json.loads((ROOT / "assets" / "course" / "data" / "public-media.json").read_text(encoding="utf-8"))
    config = json.loads((ROOT / "assets" / "course" / "data" / "runtime-config.json").read_text(encoding="utf-8"))
    require(catalog.get("moduleCount") == 10, "catalog does not contain ten modules")
    require(catalog.get("taxonCount") == 80, "catalog does not contain 80 taxa")
    require(catalog.get("gradedAssessmentCount") == 32, "catalog does not contain 32 graded assessments")
    summary = media.get("summary", {})
    require(summary.get("mediaCount") == 1083, "public teaching/practice media count changed")
    require(summary.get("taxaCount") == 80, "public media does not cover all 80 taxa")
    require(summary.get("privateExaminationAssetsIncluded") == 0, "private examination assets entered public media")

    forbidden_files = [path for path in ROOT.rglob("private_*seed.sql") if path.is_file()]
    require(not forbidden_files, "private answer-bearing seed found in public repository")
    public_asset_text = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in (ROOT / "assets" / "course").rglob("*")
        if path.is_file()
    )
    for forbidden in ("accepted_answer_keys", '"private_scoring"', '"answer_basis"', "source_image_url"):
        require(forbidden not in public_asset_text, f"private answer-bearing token exposed: {forbidden}")

    app = (ROOT / "assets" / "course" / "app.js").read_text(encoding="utf-8")
    auth = (ROOT / "assets" / "course" / "auth.js").read_text(encoding="utf-8")
    for token in ("pendingNonvisual", "renderReviewerQueue", 'data-part="visual"', 'data-part="nonvisual"'):
        require(token in app, f"course application missing {token}")
    for token in ("signInWithOtp", "submitFormalItem", "getReviewQueue", "getGradeSummary"):
        require(token in auth, f"authentication client missing {token}")

    if config.get("cloudFeaturesEnabled"):
        require(str(config.get("supabaseUrl", "")).startswith("https://"), "enabled cloud config lacks Supabase URL")
        require(bool(config.get("supabasePublishableKey")), "enabled cloud config lacks publishable key")
        require(bool(config.get("turnstileSiteKey")), "enabled cloud config lacks Turnstile site key")

    print("COURSE PUBLIC RELEASE VALIDATION PASSED")
    print("modules=10")
    print("taxa=80")
    print("assessments=32")
    print("public_media=1083")
    print("private_exam_assets_exposed=0")
    print(f"cloud_features_enabled={str(bool(config.get('cloudFeaturesEnabled'))).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
