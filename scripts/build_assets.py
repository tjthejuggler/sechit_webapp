#!/usr/bin/env python3
"""Curate canonical Secret Hitler assets into public/assets/ (subtask 5).

Reads ONLY from the sibling assets project (../sechit_webapp_assets, never
modified) and writes canonical PNGs + manifest.json into public/assets/.

Orientation findings (verified visually against the 300dpi page renders):
- Card pages crop straight (party_liberal, roles, ballots, seals already upright
  except party_fascist which prints rotated 90deg CW on the sheet).
- Board pages print the halves rotated +/-90deg, 180deg opposed (fold layout):
  * liberal: sheet-left half needs CCW, sheet-right half needs CW.
    Joined order is [sheet-right][sheet-left] so the word LIBERAL reads across
    the seam and DRAW pile ends up on the far left, DISCARD far right.
  * fascist: track half needs CW, summary half needs CCW.

Tool: python3 + Pillow (no ImageMagick needed).
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

SRC = Path("/home/twain/Projects/sechit_webapp_assets")
PAGES = SRC / "pages300"
SCRATCH = SRC / "scratch"
TR_SRC = SRC / "assets" / "tr"          # Turkish board art (boards/ + icons/)
GEN_SRC = SRC / "assets_gen"            # generated art (TR logo raw)
OUT = Path(__file__).resolve().parent.parent / "public" / "assets"

CW = Image.Transpose.ROTATE_270   # rotate 90deg clockwise
CCW = Image.Transpose.ROTATE_90   # rotate 90deg counter-clockwise


def rotate(img: Image.Image, direction: Image.Transpose) -> Image.Image:
    return img.transpose(direction)


def copy_src(rel: str, dest_name: str) -> dict:
    """Plain copy of an already-correct crop."""
    src = SCRATCH / rel
    dest = OUT / dest_name
    shutil.copyfile(src, dest)
    with Image.open(dest) as im:
        return {"file": dest_name, "width": im.width, "height": im.height}


def logo_transparent(dest_name: str) -> dict:
    """Derive an RGBA logo from logo.png (grey art): alpha from darkness,
    ink recoloured to the near-black brand tone used by the PnP PDF.
    (Recreates the scratch/logo_transparent.png pipeline in extract_assets.py,
    which is not present in the source tree any more.)
    """
    with Image.open(SCRATCH / "logo.png").convert("L") as im:
        g = np.asarray(im).astype(np.float32)
    alpha = np.clip((235.0 - g) * (255.0 / 160.0), 0, 255).astype(np.uint8)
    h, w = alpha.shape
    rgba = np.dstack([
        np.full((h, w), 43, np.uint8),
        np.full((h, w), 39, np.uint8),
        np.full((h, w), 38, np.uint8),
        alpha,
    ])
    dest = OUT / dest_name
    Image.fromarray(rgba, "RGBA").save(dest)
    return {"file": dest_name, "width": w, "height": h}


def from_crop(rel: str, dest_name: str, direction: Image.Transpose | None = None) -> dict:
    """Copy a crop, optionally rotating it upright."""
    with Image.open(SCRATCH / rel) as im:
        out = im.transpose(direction) if direction is not None else im.copy()
        out.save(OUT / dest_name)
        return {"file": dest_name, "width": out.width, "height": out.height}


# Printed sheets carry a white paper margin + a thin frame line on every edge.
# At a DISPLAY junction (two halves butted side by side) those margins stack into
# a visible white band with a doubled border, so they are excised and the two
# interiors are joined seamlessly. Measured at 300 dpi:
#   - liberal halves: 6 px frame line + ~28 px margin = 35 px per junction edge
#   - fascist track half right edge: 35 px; summary half left edge: 29 px
#     (its frame line is mostly clipped in the source crop: 1 px remnant + 28 px)
SEAM_TRIM_LIBERAL = 35
SEAM_TRIM_TRACK = 35
SEAM_TRIM_SUMMARY = 29


def trim_seam(img: Image.Image, side: str, px: int) -> Image.Image:
    """Cut the sheet margin + frame line off one junction edge of a board half.
    side='left' removes img[:, :px]; side='right' removes img[:, -px:]."""
    if side == 'left':
        return img.crop((px, 0, img.width, img.height))
    return img.crop((0, 0, img.width - px, img.height))


def assert_not_blank_edge(img: Image.Image, side: str, name: str) -> None:
    """Guard: the trimmed junction edge must show interior content, not a
    leftover white margin column (mean brightness < 250)."""
    arr = np.asarray(img.convert('L')).astype(np.float32)
    col = arr.mean(axis=0)
    edge = float(col[0]) if side == 'left' else float(col[-1])
    if edge >= 250:
        raise SystemExit(
            f"SEAM TRIM FAILED for {name} ({side} edge): column is blank white "
            f"(mean {edge:.0f}) — adjust the SEAM_TRIM constants.")


def from_crop_seam(rel: str, dest_name: str, direction: Image.Transpose,
                   side: str, px: int) -> dict:
    """Rotate upright, excise the junction-edge margin/line, save."""
    with Image.open(SCRATCH / rel) as im:
        out = trim_seam(im.transpose(direction), side, px)
        assert_not_blank_edge(out, side, dest_name)
        out.save(OUT / dest_name)
        return {"file": dest_name, "width": out.width, "height": out.height}


def liberal_board() -> dict:
    """Re-crop both halves from the 300dpi page-10 render with mirrored
    bounds (identical pixel sizes), rotate each upright, join for display.
    """
    with Image.open(PAGES / "page-10.png") as page:
        W, H = page.size
        fx = {"x0": 0.043, "y0": 0.072, "xm": 0.502, "xm2": 0.498, "x1": 0.957, "y1": 0.922}
        box = lambda a, b, c, d: (int(a * W), int(b * H), int(c * W), int(d * H))
        left = page.crop(box(fx["x0"], fx["y0"], fx["xm"], fx["y1"]))    # sheet-left slab
        right = page.crop(box(fx["xm2"], fx["y0"], fx["x1"], fx["y1"]))  # sheet-right slab
    left_u = rotate(left, CCW)    # DISCARD half, upright
    right_u = rotate(right, CW)   # DRAW half, upright
    assert left_u.height == right_u.height, (left_u.size, right_u.size)
    # Seamless display join: excise the sheet margin + frame line where the
    # halves meet (right edge of the DRAW half, left edge of the DISCARD half),
    # then butt the interiors — no white band, no doubled border.
    right_u = trim_seam(right_u, 'right', SEAM_TRIM_LIBERAL)
    left_u = trim_seam(left_u, 'left', SEAM_TRIM_LIBERAL)
    assert_not_blank_edge(right_u, 'right', 'board_liberal (draw half junction)')
    assert_not_blank_edge(left_u, 'left', 'board_liberal (discard half junction)')
    joined = Image.new("RGB", (left_u.width + right_u.width, left_u.height), "white")
    joined.paste(right_u, (0, 0))             # DRAW/LIBE half first
    joined.paste(left_u, (right_u.width, 0))  # RAL/DISCARD half second
    dest = OUT / "board_liberal.png"
    joined.save(dest)
    return {"file": dest.name, "width": joined.width, "height": joined.height}


# ============================================================================
# Turkish (TR) variants — localised board art from assets/tr/ (read-only).
# The TR boards were translated in-place from the EN sheet crops with the SAME
# print geometry (verified: junction margins/frame lines at identical offsets),
# so the same seam trims apply and every output dimension matches its EN twin.
# Clients keep ONE set of overlay coordinates per language (see board.js
# BOARD_GEO); the liberal TR art additionally gets a tiny horizontal resample
# (0.4%) so it lands exactly on the EN 4266x1515 display canvas.

# TR liberal junction band (measured at 300dpi): left half frame line
# ~2126-2133, sheet margin 2134-2183, right half frame line 2184-2193.
TR_LIBERAL_CUT = (2124, 2194)
TR_LIBERAL_OUT_W = 4266   # match the EN display canvas exactly


def tr_fascist_half(rel: str, dest_name: str, side: str, px: int) -> dict:
    """TR halves are already upright: excise the junction margin/line only."""
    with Image.open(TR_SRC / "boards" / rel) as im:
        out = trim_seam(im.convert("RGB"), side, px)
        assert_not_blank_edge(out, side, dest_name)
        out.save(OUT / dest_name)
        return {"file": dest_name, "width": out.width, "height": out.height}


def tr_liberal_board(dest_name: str) -> dict:
    """Stitch-free TR liberal: excise the doubled junction band (both frame
    lines + sheet margin) and resample horizontally onto the EN 4266px canvas
    so all CSS aspect ratios / overlay fractions stay valid for both langs."""
    with Image.open(TR_SRC / "boards" / "board_liberal.png") as im:
        rgb = im.convert("RGB")
    x0, x1 = TR_LIBERAL_CUT
    left = rgb.crop((0, 0, x0, rgb.height))
    right = rgb.crop((x1, 0, rgb.width, rgb.height))
    joined = Image.new("RGB", (left.width + right.width, rgb.height), "white")
    joined.paste(left, (0, 0))
    joined.paste(right, (left.width, 0))
    final = joined.resize((TR_LIBERAL_OUT_W, rgb.height), Image.LANCZOS)
    dest = OUT / dest_name
    final.save(dest)
    return {"file": dest.name, "width": final.width, "height": final.height}


def logo_transparent_tr(dest_name: str) -> dict:
    """TR 'GIZLI HITLER' logo: same alpha-from-darkness + brand-ink recipe as
    the EN logo_transparent, applied to the generated raw (white background)."""
    with Image.open(GEN_SRC / "logo_tr_raw.png").convert("L") as im:
        g = np.asarray(im).astype(np.float32)
    alpha = np.clip((235.0 - g) * (255.0 / 160.0), 0, 255).astype(np.uint8)
    h, w = alpha.shape
    rgba = np.dstack([
        np.full((h, w), 43, np.uint8),
        np.full((h, w), 39, np.uint8),
        np.full((h, w), 38, np.uint8),
        alpha,
    ])
    dest = OUT / dest_name
    Image.fromarray(rgba, "RGBA").save(dest)
    return {"file": dest_name, "width": w, "height": h}


def build_tr(assets: dict) -> None:
    """Publish Turkish variants as <name>_tr.png beside the EN files and
    register a per-asset `lang` map in the manifest. Existing EN paths and
    dimensions stay untouched; assets with no TR art simply get no `lang` key
    and clients fall back to the (language-neutral) EN file."""
    # Fascist halves: TR sources are upright -> seam trim only (same px as EN).
    for n in ("5-6", "7-8", "9-10"):
        assets[f"board_fascist_{n}_tr"] = tr_fascist_half(
            f"board_fascist_track_{n}.png", f"board_fascist_{n}_tr.png",
            'right', SEAM_TRIM_TRACK)
        assets[f"board_fascist_summary_{n}_tr"] = tr_fascist_half(
            f"board_fascist_summary_{n}.png", f"board_fascist_summary_{n}_tr.png",
            'left', SEAM_TRIM_SUMMARY)
    assets["board_liberal_tr"] = tr_liberal_board("board_liberal_tr.png")
    assets["logo_transparent_tr"] = logo_transparent_tr("logo_transparent_tr.png")

    # Localised variants map (consumed by public/shared/i18n.js asset swap).
    LANG_MAP = {
        "board_liberal": "board_liberal_tr",
        "board_fascist_5-6": "board_fascist_5-6_tr",
        "board_fascist_summary_5-6": "board_fascist_summary_5-6_tr",
        "board_fascist_7-8": "board_fascist_7-8_tr",
        "board_fascist_summary_7-8": "board_fascist_summary_7-8_tr",
        "board_fascist_9-10": "board_fascist_9-10_tr",
        "board_fascist_summary_9-10": "board_fascist_summary_9-10_tr",
        "logo_transparent": "logo_transparent_tr",
    }
    for base, tr_name in LANG_MAP.items():
        assets[tr_name]["kind"] = assets[base]["kind"]
        assets[base]["lang"] = {"en": assets[base]["file"],
                                "tr": assets[tr_name]["file"]}
    # TR executive-action icons are byte-identical to EN (language-neutral
    # pictograms) — no _tr copies are shipped for icons.


def build() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    assets: dict[str, dict] = {}

    assets["logo"] = copy_src("logo.png", "logo.png")
    assets["logo_transparent"] = logo_transparent("logo_transparent.png")

    assets["plaque_president"] = copy_src("plaque_president.png", "plaque_president.png")
    assets["plaque_chancellor"] = copy_src("plaque_chancellor.png", "plaque_chancellor.png")

    assets["role_liberal"] = from_crop("page07/07_00.png", "role_liberal.png")
    assets["role_fascist"] = from_crop("page08/08_03.png", "role_fascist.png")
    assets["role_hitler"] = from_crop("page08/08_02.png", "role_hitler.png")

    assets["party_liberal"] = from_crop("page04/04_02.png", "party_liberal.png")
    assets["party_fascist"] = from_crop("page02/02_05.png", "party_fascist.png", CW)

    assets["ballot_ja"] = from_crop("page05/05_00.png", "ballot_ja.png")
    assets["ballot_nein"] = from_crop("page06/06_00.png", "ballot_nein.png")

    assets["seal_liberal"] = from_crop("page09/09_02.png", "seal_liberal.png")
    assets["seal_fascist"] = from_crop("page09/09_00.png", "seal_fascist.png")

    assets["pile_draw"] = from_crop("page08/08_05.png", "pile_draw.png")
    assets["pile_discard"] = from_crop("page08/08_00.png", "pile_discard.png")

    assets["board_liberal"] = liberal_board()

    # Fascist halves are displayed butted together (track | summary): trim the
    # junction margins/lines so the pair joins seamlessly at runtime.
    for n in ("5-6", "7-8", "9-10"):
        assets[f"board_fascist_{n}"] = from_crop_seam(
            f"board_fascist_track_{n}.png", f"board_fascist_{n}.png", CW,
            'right', SEAM_TRIM_TRACK)
        assets[f"board_fascist_summary_{n}"] = from_crop_seam(
            f"board_fascist_summary_{n}.png", f"board_fascist_summary_{n}.png", CCW,
            'left', SEAM_TRIM_SUMMARY)

    kinds = {
        "logo": "logo", "logo_transparent": "logo",
        "plaque_president": "plaque", "plaque_chancellor": "plaque",
        "role_liberal": "role", "role_fascist": "role", "role_hitler": "role",
        "party_liberal": "party", "party_fascist": "party",
        "ballot_ja": "ballot", "ballot_nein": "ballot",
        "seal_liberal": "seal", "seal_fascist": "seal",
        "pile_draw": "pile-marker", "pile_discard": "pile-marker",
        "board_liberal": "board",
    }
    for name, meta in assets.items():
        meta["kind"] = kinds.get(name, "board-half")

    missing = [
        {"name": "policy_liberal",
         "reason": "No standalone liberal policy tile artwork exists in the PnP PDF; "
                   "UI should render tiles with CSS (blue rectangle)."},
        {"name": "policy_fascist",
         "reason": "No standalone fascist policy tile artwork exists in the PnP PDF; "
                   "UI should render tiles with CSS (red rectangle)."},
        {"name": "card_back",
         "reason": "The PDF contains no card-back design; UI should render card backs "
                   "with CSS (party colour + seal image reusable from assets)."},
    ]

    notes = [
        "party_fascist prints rotated 90deg CW on the sheet; shipped upright (portrait).",
        "ballot_ja / ballot_nein keep the authentic PnP layout: text printed sideways "
        "on a portrait card; rotate via CSS if horizontal text is preferred.",
        "plaque text runs vertically by design (wrap-around podium plaques).",
        "board_liberal.png joins the two sheet halves (re-cropped from page-10 at "
        "300dpi with mirrored bounds for identical sizes); DRAW pile left, DISCARD right. "
        "Junction margins + frame lines are excised so halves display seamlessly.",
        "board_fascist_N.png / board_fascist_summary_N.png junction edges are "
        "trimmed (35px / 29px) so the pair butts seamlessly on screen.",
        "board_fascist_N.png is the policy-track half; board_fascist_summary_N.png is "
        "the powers/summary half (shipped separately for flexible UI layout).",
        "Turkish variants (*_tr.png) are localised redrawing of the same print "
        "geometry: identical seam trims as EN, and board_liberal_tr.png is "
        "resampled 0.4% horizontally onto the EN 4266x1515 canvas so overlay "
        "coordinates stay valid. Per-language overlay constants live in "
        "public/board/board.js (BOARD_GEO).",
        "Assets WITHOUT a `lang` map (plaques, role/party cards, ballots, seals, "
        "pile art, executive-action icons) are language-neutral: EN art is shown "
        "for both languages.",
    ]

    manifest = {
        "game": "Secret Hitler",
        "license": "CC BY-NC-SA 4.0 (secrethitler.com print-and-play PDF)",
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tool": "python3 + Pillow 12.x (scripts/build_assets.py)",
        "source_root": "/home/twain/Projects/sechit_webapp_assets (read-only)",
        "assets": assets,
        "missing": missing,
        "notes": notes,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def validate(manifest: dict) -> None:
    problems = []
    for name, meta in manifest["assets"].items():
        path = OUT / meta["file"]
        if not path.is_file():
            problems.append(f"{name}: file missing on disk")
            continue
        with Image.open(path) as im:
            im.verify()  # PNG integrity
        with Image.open(path) as im:
            if (im.width, im.height) != (meta["width"], meta["height"]):
                problems.append(
                    f"{name}: dims {im.width}x{im.height} != manifest "
                    f"{meta['width']}x{meta['height']}")
            if im.format != "PNG":
                problems.append(f"{name}: format {im.format} != PNG")
    if problems:
        raise SystemExit("VALIDATION FAILED:\n" + "\n".join(problems))
    print(f"OK: {len(manifest['assets'])} assets validated against manifest")
    for name, meta in manifest["assets"].items():
        print(f"  {name:28s} {meta['file']:34s} {meta['width']}x{meta['height']}  {meta['kind']}")
    print("missing:", ", ".join(m["name"] for m in manifest["missing"]))


if __name__ == "__main__":
    manifest = build()
    build_tr(manifest["assets"])
    manifest["generated_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    validate(manifest)
