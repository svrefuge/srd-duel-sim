#!/usr/bin/env python3
"""Regenerate data/ from the System Reference Document 5.2.1 PDF.

The bundled JSON in data/ is produced only by this script, from the text layer of
WotC's own SRD 5.2.1 PDF. Nothing is copied from third-party compilations, and no
stat block outside the SRD is emitted.

Usage:
    pip install -r tools/requirements.txt
    python tools/build_srd_data.py path/to/SRD_CC_v5.2.1.pdf

Download the PDF from https://www.dndbeyond.com/srd (CC BY 4.0).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from srd import bestiary, extract, monsters, spells  # noqa: E402

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
BESTIARY_OUT = 'bestiary-srd-5.2.1.json'
SPELLS_OUT = 'spells-srd-5.2.1.json'

# Guards against silently shipping a short or over-broad parse.
EXPECT_MONSTERS = 330
EXPECT_SPELLS = 339


def write_json(path, payload):
    with open(path, 'w') as fh:
        json.dump(payload, fh, indent=1)
        fh.write('\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('pdf', help='path to SRD_CC_v5.2.1.pdf')
    ap.add_argument('--out', default=DATA_DIR, help='output directory (default: data/)')
    args = ap.parse_args()

    if not os.path.exists(args.pdf):
        ap.error('no such file: %s' % args.pdf)

    print('reading %s' % args.pdf)
    lines = extract.load_lines(args.pdf)
    words = extract.load_words(args.pdf)
    print('  %d text lines' % len(lines))

    monster_recs = bestiary.build_all(lines, words)
    spell_recs = spells.build_all(lines, words)
    print('  %d monsters, %d spells' % (len(monster_recs), len(spell_recs)))

    for note in monsters.WARNINGS:
        print('  note: %s' % note)

    problems = []
    if len(monster_recs) != EXPECT_MONSTERS:
        problems.append('expected %d monsters, parsed %d' % (EXPECT_MONSTERS, len(monster_recs)))
    if len(spell_recs) != EXPECT_SPELLS:
        problems.append('expected %d spells, parsed %d' % (EXPECT_SPELLS, len(spell_recs)))
    blob = json.dumps({'monster': monster_recs, 'spell': spell_recs})
    for marker in ('XMM', 'XPHB', 'XDMG', 'soundClip', 'referenceSources'):
        if marker in blob:
            problems.append('output mentions non-SRD marker %r' % marker)
    if problems:
        for p in problems:
            print('ERROR: %s' % p, file=sys.stderr)
        return 1

    write_json(os.path.join(args.out, BESTIARY_OUT), {'monster': monster_recs})
    write_json(os.path.join(args.out, SPELLS_OUT), {'spell': spell_recs})
    print('wrote %s and %s to %s' % (BESTIARY_OUT, SPELLS_OUT, args.out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
