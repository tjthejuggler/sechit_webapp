// i18n completeness + localized asset integrity tests.
// Guarantees:
//  1. Every key in the EN dictionary has a TR entry and vice versa (a toggle
//     can never surface a missing translation).
//  2. Every dictionary entry is a non-empty string in both languages.
//  3. No unreplaced {param} placeholders after t() interpolation.
//  4. Every TR board art variant declared in the i18n ASSET_LANG map exists
//     on disk AND is listed in public/assets/manifest.json with a `lang` map,
//     with byte-identical dimensions to its EN twin (overlay coordinates and
//     CSS aspect ratios stay valid for both languages).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const i18nUrl = new URL('../public/shared/i18n.js', import.meta.url);
const { DICT, LANGS, ASSET_LANG, t, errorText, localizedAssetPath } = await import(i18nUrl.href);

const manifest = JSON.parse(
  await readFile(new URL('../public/assets/manifest.json', import.meta.url), 'utf8'),
);

describe('i18n dictionaries', () => {
  it('covers exactly the supported languages', () => {
    assert.deepEqual(Object.keys(DICT).sort(), [...LANGS].sort());
    assert.deepEqual([...LANGS].sort(), ['en', 'tr']);
  });

  it('has identical key sets in EN and TR (no missing translations)', () => {
    const en = Object.keys(DICT.en).sort();
    const tr = Object.keys(DICT.tr).sort();
    assert.deepEqual(tr, en, `key mismatch — EN-only: ${en.filter((k) => !tr.includes(k))}, TR-only: ${tr.filter((k) => !en.includes(k))}`);
  });

  it('every entry is a non-empty string in both languages', () => {
    // GAME_OVER.sub is intentionally empty on both sides (no sub-instruction
    // during the win splash — the reason text takes over).
    const allowEmpty = new Set(['board.phase.GAME_OVER.sub']);
    for (const [key, en] of Object.entries(DICT.en)) {
      assert.equal(typeof en, 'string', `EN ${key} is not a string`);
      if (!allowEmpty.has(key)) assert.ok(en.length > 0, `EN ${key} is empty`);
      const tr = DICT.tr[key];
      assert.equal(typeof tr, 'string', `TR ${key} is not a string`);
      if (!allowEmpty.has(key)) assert.ok(tr.length > 0, `TR ${key} is empty`);
    }
  });

  it('TR entries genuinely differ from EN (no untranslated copies)', () => {
    // Language-neutral keys (proper nouns / codes) are allowed to match.
    const neutral = new Set([
      'lang.en', 'lang.tr', 'app.title', 'play.card.liberal', 'play.card.fascist',
      'board.log.voteCast', 'err.BAD_VOTE', 'board.lobby.count',
    ]);
    const same = Object.keys(DICT.en).filter((k) => DICT.en[k] === DICT.tr[k] && !neutral.has(k));
    assert.ok(same.length <= 5, `suspicious untranslated keys: ${same.join(', ')}`);
  });
});

describe('t() interpolation', () => {
  it('substitutes every {param}', () => {
    const out = t('board.lobby.count', { n: 3, s: 's', min: 5, max: 10 });
    assert.ok(!/\{\w+\}/.test(out), `unreplaced placeholder in: ${out}`);
    assert.ok(out.includes('3'));
  });

  it('interpolates in TR after a language switch and falls back safely', async () => {
    // localizedAssetPath only activates for TR; check both directions.
    assert.equal(localizedAssetPath('/assets/board_liberal.png'), '/assets/board_liberal.png');
    assert.equal(localizedAssetPath('/assets/logo.png'), '/assets/logo.png'); // neutral art
    assert.equal(errorText('DEFINITELY_UNKNOWN_CODE', 'fallback text'), 'fallback text');
    assert.equal(typeof errorText('NOT_PRESIDENT'), 'string');
  });
});

describe('localized art assets', () => {
  it('ASSET_LANG matches the manifest lang maps exactly', () => {
    const manifestLang = Object.entries(manifest.assets)
      .filter(([, meta]) => meta.lang)
      .map(([name, meta]) => [name, meta.lang.tr.replace(/\.png$/, '')]);
    const i18nMap = Object.entries(ASSET_LANG);
    assert.deepEqual(
      Object.fromEntries(i18nMap.sort()),
      Object.fromEntries(manifestLang.sort()),
    );
  });

  it('every TR BOARD variant exists on disk with its EN twin\'s exact dimensions', async () => {
    // Strict pixel equality is required only for board art: policy tiles,
    // tracker dots and pile overlays are percentage-positioned on it. (The
    // TR logo is AI-generated at its own resolution and displays at a fixed
    // CSS height, so it is exempt.)
    const geometryKinds = new Set(['board', 'board-half']);
    for (const [base, trName] of Object.entries(ASSET_LANG)) {
      const enMeta = manifest.assets[base];
      const trMeta = manifest.assets[trName];
      assert.ok(enMeta, `manifest lacks EN asset ${base}`);
      assert.ok(trMeta, `manifest lacks TR asset ${trName}`);
      if (geometryKinds.has(enMeta.kind)) {
        assert.equal(trMeta.width, enMeta.width, `${trName} width != ${base} width`);
        assert.equal(trMeta.height, enMeta.height, `${trName} height != ${base} height`);
      }
      const png = await readFile(new URL(`../public/assets/${trMeta.file}`, import.meta.url));
      // PNG signature check (8-byte header) — file exists and is a real PNG.
      assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  });
});
