# Bundled SRD data

Both files are generated from the System Reference Document 5.2.1 PDF by
`tools/build_srd_data.py`. Nothing here is copied from a third-party compilation,
and no record originates outside the SRD.

- `bestiary-srd-5.2.1.json`: all 330 stat blocks printed in the SRD 5.2.1 bestiary.
- `spells-srd-5.2.1.json`: all 339 spell descriptions in the SRD 5.2.1, used to
  compile monster spellcasting.

Every record carries `"source": "SRD"`. The compiler reads no data from outside
this directory, and a test asserts that these files mention no non-SRD source.

The bestiary contains only the bestiary chapter's stat blocks. The SRD also prints
a handful of stat blocks inside spell and magic-item descriptions (Otherworldly
Steed, Draconic Spirit, Giant Insect, Giant Fly, Avatar of Death, Animated Object);
those are summons rather than combatants and are deliberately excluded.

To regenerate, see "Regenerating the data" in `docs/METHOD.md`.
See `NOTICE.md` for the SRD 5.2.1 attribution, the CC BY 4.0 license notice, and
the list of changes made to the licensed material.
