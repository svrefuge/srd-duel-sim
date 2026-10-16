# Licensing notices

## SRD attribution

This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

The attribution above applies to SRD-derived material wherever it appears in this repository or its generated outputs: the monster and spell data in `data/`, SRD quotations in tests, code comments and documentation, extracted text and compiled combat records, and the class stat blocks in `pc-pilot/`. This material is licensed under CC BY 4.0, rather than the software license covering the surrounding original code. When redistributing SRD-derived outputs separately, retain this attribution, the license link and the applicable indication of modifications.

Section 5 of CC BY 4.0 includes a Disclaimer of Warranties and Limitation of Liability. This project is not sponsored or endorsed by Wizards of the Coast.

## Changes made to the licensed material

The material in `data/` has been modified. It was extracted from the text layer of the SRD 5.2.1 PDF by `tools/build_srd_data.py` and restructured into JSON for machine consumption. Specifically:

- Stat blocks and spell descriptions were parsed into structured records; the printed prose is preserved but is wrapped in inline markup (for example `{@damage 2d6 + 5}`, `{@actSave con}`) that is not part of the original.
- Fields that the SRD prints as prose were also recorded in derived form, including ability-score modifiers and saves, movement speeds, damage and condition defenses, spell ranges and durations, and which saving throw or damage type a spell uses.
- Named sequential effects retain separate list entries. Casting times retain reaction triggers, explicitly borrowing spellcasting features inherit the primary casting ability, and healing and damage increases use distinct scaling markup.
- Material the simulator does not use was omitted, including flavor text, class spell lists, magic items, and the rules chapters.
- One typographic correction was applied: the Young White Dragon's Intelligence saving throw prints without its sign in the PDF, and is recorded as equal to the modifier. The generator reports this as a note when it runs.

Compiled combat records further normalize this material into simulator fields and omit unsupported mechanics. The reference-text extractor adds page markers and converts the PDF text to plain text. SRD excerpts in tests, comments and documentation may be shortened or have whitespace normalized; surrounding explanations and test expectations are original project material.

The class stat blocks in `pc-pilot/` are built from the SRD 5.2.1 classes, subclasses, spells and equipment. Class features are restated in stat-block form, mostly in the project's own words (the Evasion trait is adapted from the SRD text); fixed choices are made for ability scores, equipment and prepared spells; and some features are approximated or left out, as `pc-pilot/README.md` lists.

The bundled monster, spell and class material comes only from the SRD 5.2.1.

## Python tools and PyMuPDF

The Python source files under `tools/`, including the extraction library, command-line scripts and Python tests, are licensed under the GNU Affero General Public License version 3 only (AGPL-3.0-only); see [tools/LICENSE.md](tools/LICENSE.md) and [the full license](tools/LICENSE-AGPL-3.0.txt). The original TypeScript simulator code remains MIT-licensed.

The tools depend on PyMuPDF 1.26.5, which includes MuPDF. PyMuPDF and MuPDF are offered under AGPL v3 or a separate commercial license from Artifex. This project's tools use the AGPL option; no commercial license is included or implied. The dependencies are installed separately and retain their upstream copyright and license notices. See [PyMuPDF's license documentation](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright).

Redistribution of the tools together with their AGPL dependencies must comply with the AGPL, including its applicable license-notice and corresponding-source requirements. The source of this project's tools is provided in `tools/`; dependency source must also be made available as required when conveying a combined distribution. The AGPL's applicable network-source requirements also apply to modified covered software offered for remote interaction.

Using these tools to extract SRD text does not change that text's CC BY 4.0 license. The TypeScript simulator reads the generated JSON and neither imports nor bundles PyMuPDF.

## Other dependencies

The npm development dependencies are separately licensed: TypeScript under Apache-2.0, and `@types/node` and `undici-types` under MIT. Their licenses are supplied with their installed packages. The repository's MIT license does not replace any third-party license.
