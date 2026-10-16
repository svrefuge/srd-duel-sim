"""Assemble full monster stat-block records from the SRD PDF."""
import re
from . import monsters, entries
from .extract import line_text
from .monsters import norm

SECTION_KEYS = entries.SECTION_KEYS


def sections_of(rest_lines):
    """Split the post-header lines into {section_name: [lines]}."""
    out, cur = {}, None
    for l in rest_lines:
        s = l['spans'][0]
        txt = line_text(l).strip()
        if s['f'] == 'GillSans' and s['sz'] >= 11.5 and txt in SECTION_KEYS:
            cur = txt
            out.setdefault(cur, [])
            continue
        if cur:
            out[cur].append(l)
    return out


DISPLAY_AS = {'Actions': 'action', 'Bonus Actions': 'bonus',
              'Reactions': 'reaction', 'Legendary Actions': 'legendary'}


def build_entries(lines):
    ents, preamble = entries.split_entries(lines)
    out = []
    for e in ents:
        paras = entries.entry_pieces(e['lines'])
        name, texts = None, []
        for i, p in enumerate(paras):
            text, fonts = entries.wrap_join(p)
            if i == 0:
                name, text, fonts = entries.strip_name(text, fonts)
            texts.append((text, fonts))
        out.append({'name': name, 'paras': texts, 'lines': e['lines']})
    return out, preamble


def render(name, paras):
    rec = {'name': entries.tag_name(name), 'entries': []}
    for text, fonts in paras:
        t = entries.tag_prose(text, fonts)
        t = entries.tag_terms(t)
        rec['entries'].append(re.sub(r'\s+', ' ', t).strip())
    # Preserve named sequence steps instead of passing one combined effect to
    # the action parser. The SRD currently has this structure only on Roar.
    joined = ' '.join(rec['entries'])
    if re.search(r'has a different effect|as detailed below|the sequence resets', joined, re.I):
        heads = list(re.finditer(r'\b(First|Second|Third) Roar\.\s*', joined))
        if [h.group(1) for h in heads] == ['First', 'Second', 'Third']:
            rec['entries'] = [joined[:heads[0].start()].strip(), {
                'type': 'list', 'style': 'list-hang-notitle', 'items': [{
                    'type': 'item', 'name': h.group(1) + ' Roar',
                    'entries': [joined[h.end():heads[i + 1].start() if i + 1 < len(heads) else len(joined)].strip()],
                } for i, h in enumerate(heads)],
            }]
    return rec


def inherit_spellcasting_abilities(rec):
    """Only explicitly borrowing features inherit the primary casting ability."""
    primary = next((b for b in rec.get('spellcasting', []) if b['name'] == 'Spellcasting'), None)
    if primary and primary.get('ability'):
        for block in rec['spellcasting']:
            if re.search(r'using the same spellcasting ability as Spellcasting',
                         ' '.join(block.get('headerEntries', [])), re.I):
                block.setdefault('ability', primary['ability'])


def build_all(lines, words):
    blocks = monsters.load_blocks(lines, words)
    out = []
    for name, body in blocks:
        rec, rest, _fields = monsters.build_record(name, body)
        secs = sections_of(rest)
        for label, key in SECTION_KEYS.items():
            if label not in secs:
                continue
            ents, preamble = build_entries(secs[label])
            rendered, casting = [], []
            display_as = DISPLAY_AS.get(label, 'action')
            for e in ents:
                if re.match(r'^Spellcasting\b', e['name'] or ''):
                    casting.append(entries.parse_spellcasting(e['lines'], display_as))
                    continue
                out_entry = render(e['name'], e['paras'])
                if entries.is_cast_entry(' '.join(t for t in out_entry['entries'] if isinstance(t, str))):
                    casting.append(entries.build_cast_block(
                        out_entry['name'], out_entry['entries'], display_as))
                    continue
                rendered.append(out_entry)
            if rendered:
                rec[key] = rendered
            if casting:
                rec.setdefault('spellcasting', []).extend(casting)
        inherit_spellcasting_abilities(rec)
        out.append(rec)
    return out
