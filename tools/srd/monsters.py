"""Parse SRD 5.2.1 monster stat blocks out of the PDF into tagged JSON."""
import re
from .extract import line_text, is_name, is_group, is_body

SIZES = {'Tiny': 'T', 'Small': 'S', 'Medium': 'M', 'Large': 'L', 'Huge': 'H', 'Gargantuan': 'G'}
ABILS = ['str', 'dex', 'con', 'int', 'wis', 'cha']
SECTION_HDRS = {'Traits', 'Actions', 'Bonus Actions', 'Reactions', 'Legendary Actions'}
LABELS = ('AC', 'HP', 'Speed', 'Initiative', 'Skills', 'Resistances', 'Immunities',
          'Vulnerabilities', 'Senses', 'Languages', 'CR', 'Gear')


def norm(t):
    # U+2212 MINUS and U+2013 EN DASH both stand in for a minus sign in the stat
    # blocks ('1d4 - 1'); the em dash is real punctuation and is left alone.
    return (t.replace('’', "'").replace('‘', "'")
             .replace('“', '"').replace('”', '"')
             .replace('\xa0', ' ').replace('−', '-').replace('–', '-')
             .replace('\t', ' '))


def build_vocab(lines):
    """Words that appear NOT split across a line break, for de-hyphenation decisions."""
    vocab = set()
    for l in lines:
        for w in re.findall(r"[A-Za-z][A-Za-z'-]*", norm(line_text(l))):
            w = w.strip('-')
            if w:
                vocab.add(w.lower())
    return vocab


VOCAB = set()
WARNINGS = []


def join_wrapped(parts):
    """Join PDF line fragments, resolving end-of-line hyphens against the vocabulary."""
    out = ''
    for part in parts:
        if not out:
            out = part
            continue
        if out.endswith('-'):
            left = re.search(r"([A-Za-z][A-Za-z'-]*)-$", out)
            right = re.match(r"([A-Za-z][A-Za-z'-]*)", part)
            if left and right:
                merged = (left.group(1) + right.group(1)).lower()
                kept = (left.group(1) + '-' + right.group(1)).lower()
                # soft hyphen if the merged form is a real word and the compound isn't
                if merged in VOCAB and kept not in VOCAB:
                    out = out[:-1] + part
                    continue
                if kept in VOCAB and merged not in VOCAB:
                    out = out + part
                    continue
                # ambiguous: digits or a known compound head keep the hyphen
                if re.search(r"\d-$|foot-$|feet-$", out) or kept in VOCAB:
                    out = out + part
                    continue
                out = out[:-1] + part
                continue
            out = out + part
            continue
        if not out.endswith(' ') and not part.startswith(' '):
            out += ' '
        out += part
    return re.sub(r'  +', ' ', out).strip()


SIZE_RANK = {'T': 0, 'S': 1, 'M': 2, 'L': 3, 'H': 4, 'G': 5}


def parse_meta(text):
    """Parse the size/type/alignment line.

    Three shapes occur:
      'Large Aberration, Lawful Evil'
      'Medium or Small Humanoid (Wizard), Neutral'
      'Large Swarm of Tiny Beasts, Unaligned'
    """
    text = text.strip()
    swarm = re.match(r'^(.*?)\s+Swarm of\s+(Tiny|Small|Medium|Large|Huge|Gargantuan)\s+'
                     r'([A-Za-z]+?)s?\s*(?:\(([^)]*)\))?\s*,', text)
    if swarm:
        sizes = [SIZES[s] for s in re.findall(
            r'Tiny|Small|Medium|Large|Huge|Gargantuan', swarm.group(1))]
        out = {'size': sorted(set(sizes), key=lambda s: SIZE_RANK[s]),
               'type': {'type': swarm.group(3).lower(), 'swarmSize': SIZES[swarm.group(2)]}}
        return out
    m = re.match(r'^(.*?)\s+([A-Z][a-z]+)\s*(?:\(([^)]*)\))?\s*,\s*(.*)$', text)
    if not m:
        raise ValueError('meta: ' + text)
    size_part, ctype, tags, _align = m.groups()
    sizes = [SIZES[s] for s in re.findall(r'Tiny|Small|Medium|Large|Huge|Gargantuan', size_part)]
    out = {'size': sorted(set(sizes), key=lambda s: SIZE_RANK[s])}
    if tags:
        out['type'] = {'type': ctype.lower(),
                       'tags': [t.strip().lower() for t in tags.split(',')]}
    else:
        out['type'] = ctype.lower()
    return out


def parse_speed(text):
    """Parse the Speed line.

    A bare 'N ft. (condition)' chunk with no movement mode is an alternate
    walking speed for another form ('Speed 30 ft., 40 ft. (bear form only)').
    """
    speed = {}
    for chunk in split_top(text, seps=','):
        m = re.match(r'^(?:(Fly|Swim|Climb|Burrow)\s+)?(\d+)\s*ft\.?\s*(\([^)]*\))?$', chunk, re.I)
        if m:
            named, num, cond = m.group(1), int(m.group(2)), m.group(3)
            mode = (named or 'walk').lower()
            if cond and not named and 'walk' in speed:
                alt = speed.setdefault('alternate', {}).setdefault('walk', [])
                alt.append({'number': num, 'condition': cond})
                continue
            if cond:
                speed[mode] = {'number': num, 'condition': cond}
                if 'hover' in cond.lower():
                    speed['canHover'] = True
            else:
                speed[mode] = num
            continue
        m = re.match(r'^(Climb|Fly)\s+or\s+(Climb|Fly)\s+(\d+)\s*ft\.?\s*\(([^)]*)\)$', chunk, re.I)
        if m:
            speed['choose'] = {'from': sorted([m.group(1).lower(), m.group(2).lower()]),
                               'amount': int(m.group(3)), 'note': '(%s)' % m.group(4)}
            continue
        raise ValueError('speed chunk: ' + repr(chunk))
    return speed


DAMAGE_TYPES = {'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
                'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'}


def split_top(text, seps=',;', strip_period=True):
    """Split on separators that are outside parentheses."""
    out, buf, depth = [], '', 0
    for ch in text:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch in seps and depth == 0:
            out.append(buf)
            buf = ''
        else:
            buf += ch
    out.append(buf)
    cleaned = []
    for s in out:
        s = re.sub(r'\s+', ' ', s).strip()
        s = re.sub(r'\s+\)', ')', s)
        if strip_period:
            s = s.rstrip('.')
        if s:
            cleaned.append(s)
    return cleaned


def split_defense(text):
    """'Fire, Poison; Poisoned' -> (['fire','poison'], ['poisoned']).

    The semicolon is only a hint; classify each entry against the damage-type
    vocabulary so condition-only lines land in the right bucket. A trailing
    parenthetical qualifies the entry and is preserved as a note.
    """
    dmg, cond = [], []
    for item in split_top(text):
        head = re.sub(r'\s*\([^)]*\)\s*$', '', item).strip()
        note = re.search(r'(\([^)]*\))\s*$', item)
        base = head.lower()
        if base.split(' from')[0].strip() in DAMAGE_TYPES:
            dmg.append(base if not note else
                       {'special': item})
        elif re.match(r'^[a-z]+$', base) or base in CONDITIONS:
            cond.append(base if not note else
                        {'cond': True, 'conditionImmune': [base], 'note': note.group(1)})
        else:
            # free prose, e.g. "Damage type chosen for the Draconic Origin trait below"
            dmg.append({'special': item})
    return dmg, cond


CONDITIONS = {'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled',
              'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone',
              'restrained', 'stunned', 'unconscious'}


WORDS = {}

# Column offsets relative to an ability's small-caps label, measured from the
# PDF: score ~ +14..+18, modifier ~ +36, save ~ +54, next label ~ +77.
SCORE_W = (8, 28)
MOD_W = (28, 46)
SAVE_W = (46, 77)


def parse_abilities(lines):
    """Read the ability table by column position.

    Each cell is 'Label score mod save' but the numbers are split across spans
    and even across MuPDF lines with slightly different baselines, so ordering
    is unreliable. Anchor on the six small-caps labels and bucket each numeric
    word into score/modifier/save by its x offset from its label.
    """
    if not lines:
        raise ValueError('no ability lines')
    page = str(lines[0]['p'])
    ys = [l['y'] for l in lines]
    y_lo, y_hi = min(ys) - 4, max(ys) + 10
    words = [w for w in WORDS.get(page, []) if y_lo <= w[1] <= y_hi]

    anchors = []
    for l in lines:
        spans = l['spans']
        if spans[0]['sz'] < 9:
            continue
        # The label is the run of leading non-numeric spans. Most blocks set it in
        # small caps (a 9.8 initial plus a 6.8 remainder), but a few use a single
        # bold span, so key on the text rather than the font.
        label = ''
        for s in spans:
            if re.search(r'\d', s['t']):
                break
            label += s['t']
        ab = label.strip()[:3].lower()
        if ab in ABILS:
            anchors.append({'ab': ab, 'x': spans[0]['x'], 'y': l['y']})
    if len(anchors) != 6:
        raise ValueError('ability labels: %r' % [a['ab'] for a in anchors])

    out, saves = {}, {}
    for a in anchors:
        cell = {}
        for w in words:
            if abs(w[1] - a['y']) > 5:
                continue
            dx = w[0] - a['x']
            for key, (lo, hi) in (('score', SCORE_W), ('mod', MOD_W), ('save', SAVE_W)):
                if lo <= dx < hi:
                    for tok in re.findall(r'[+-]?\d+', norm(w[4])):
                        cell.setdefault(key, []).append(tok)
        for key in ('score', 'mod', 'save'):
            if key not in cell:
                raise ValueError('%s missing %s' % (a['ab'], key))
        score, mod, save = cell['score'][0], cell['mod'][0], cell['save'][0]
        out[a['ab']] = int(score)
        # A save printed without a sign means the sign glyph is missing from the
        # PDF's text layer; the modifier is then the only coherent reading.
        save_val = int(mod) if not re.match(r'^[+-]', save) else int(save)
        if save_val != int(mod):
            saves[a['ab']] = '%+d' % save_val
    return out, saves


def parse_header(hdr_lines):
    """Return (fields, abilities, saves) from the block's header region.

    Stat blocks use three label layouts: label and value inline on one line,
    two labels sharing a line with their values inline, and (rarely) a run of
    labels stacked above a matching run of values. Walking the span stream and
    zipping equal-length label/value runs handles all three.
    """
    ability_lines, stream = [], []
    for l in hdr_lines:
        if l['spans'][0]['f'].startswith('GillSans'):
            ability_lines.append(l)
            continue
        for s in l['spans']:
            txt = norm(s['t'])
            if not txt.strip():
                continue
            if s['f'] == 'Optima-Bold' and txt.strip() in LABELS:
                stream.append(('L', txt.strip()))
            else:
                stream.append(('V', txt))

    fields, i = {}, 0
    while i < len(stream):
        if stream[i][0] != 'L':
            i += 1
            continue
        labels = []
        while i < len(stream) and stream[i][0] == 'L':
            labels.append(stream[i][1])
            i += 1
        values = []
        while i < len(stream) and stream[i][0] == 'V':
            values.append(stream[i][1])
            i += 1
        if len(labels) > 1 and len(values) == len(labels):
            for lbl, val in zip(labels, values):
                fields[lbl] = val.strip()
        elif len(labels) > 1:
            # labels share a line with inline values; split the joined text back out
            joined = ' '.join(values)
            for n, lbl in enumerate(labels):
                fields[lbl] = joined if n == 0 else ''
        else:
            fields[labels[0]] = ' '.join(values).strip()
    abils, saves = parse_abilities(ability_lines)
    return fields, abils, saves


def build_record(name, lines):
    meta_line = lines[0]
    rec = {'name': name, 'source': 'SRD'}
    rec.update(parse_meta(norm(line_text(meta_line))))

    # header runs until the first section header (GillSans 12.0)
    body_start = len(lines)
    for i, l in enumerate(lines):
        s = l['spans'][0]
        if s['f'] == 'GillSans' and s['sz'] >= 11.5 and line_text(l).strip() in SECTION_HDRS:
            body_start = i
            break
    fields, abils, saves = parse_header(lines[1:body_start])
    rec.update(abils)

    rec['ac'] = [int(re.search(r'\d+', fields['AC']).group())]
    hp = re.match(r'^([\d,]+)\s*\(([^)]*)\)', fields['HP'])
    rec['hp'] = {'average': int(hp.group(1).replace(',', '')),
                 'formula': re.sub(r'\s+', ' ', hp.group(2)).strip()}
    rec['speed'] = parse_speed(fields['Speed'])
    if saves:
        rec['save'] = saves
    if 'Skills' in fields:
        skill = {}
        for m in re.finditer(r"([A-Za-z][A-Za-z' ]*?)\s*([+-]\d+)", fields['Skills']):
            skill[m.group(1).strip().lower()] = m.group(2)
        rec['skill'] = skill
    if 'Resistances' in fields:
        rec['resist'] = split_defense(fields['Resistances'])[0]
    if 'Immunities' in fields:
        dmg, cond = split_defense(fields['Immunities'])
        if dmg:
            rec['immune'] = dmg
        if cond:
            rec['conditionImmune'] = cond
    if 'Vulnerabilities' in fields:
        rec['vulnerable'] = split_defense(fields['Vulnerabilities'])[0]
    if 'Senses' in fields:
        senses = split_top(fields['Senses'], strip_period=False)
        senses = [s for s in senses if not s.lower().startswith('passive perception')]
        if senses:
            rec['senses'] = senses
    if 'Languages' in fields:
        rec['languages'] = [fields['Languages'].strip()]

    # "10 (XP 5,900, or 7,200 in lair; PB +4)" and "3 (700 XP; PB +2)" both occur.
    cr = re.match(r'^([\d/]+)\s*\(', fields['CR'])
    if not cr:
        raise ValueError('cr: ' + fields['CR'])
    rec['cr'] = cr.group(1)
    lair = re.search(r'or\s+([\d,]+)(?:\s*XP)?\s+in lair', fields['CR'], re.I)
    if lair:
        rec['cr'] = {'cr': cr.group(1), 'xpLair': int(lair.group(1).replace(',', ''))}

    # Initiative proficiency multiplier, derived from the printed bonus.
    pb = re.search(r'PB \+(\d+)', fields['CR'])
    init = re.match(r'^([+-]?\d+)', fields['Initiative'].strip())
    if pb and init:
        dex_mod = (rec['dex'] - 10) // 2
        printed, pbv = int(init.group(1)), int(pb.group(1))
        extra = printed - dex_mod
        mult = max(0, min(2, round(extra / pbv)))
        if mult:
            rec['initiative'] = {'proficiency': mult}
        if mult * pbv != extra:
            # The printed bonus is what the creature rolls with (Archmage: +7 on Dex +2, PB +4), so it is kept beside
            # the nearest multiplier.
            rec['initiative'] = dict(rec.get('initiative', {}), initiative=printed)
            WARNINGS.append('%s: printed Initiative %+d is not Dex %+d plus a multiple of '
                            'PB +%d; keeping the printed bonus beside proficiency %d'
                            % (name, printed, dex_mod, pbv, mult))
    return rec, lines[body_start:], fields


def load_blocks(lines, words):
    global VOCAB, WORDS
    WORDS = words
    VOCAB = build_vocab(lines)
    idx = [i for i, l in enumerate(lines) if is_name(l)]
    start = next(k for k, i in enumerate(idx) if line_text(lines[i]).strip() == 'Aboleth')
    blocks = []
    for k in range(start, len(idx)):
        i = idx[k]
        nxt = idx[k + 1] if k + 1 < len(idx) else len(lines)
        body = []
        for j in range(i + 1, nxt):
            l = lines[j]
            if is_group(l) or is_body(l):
                break
            body.append(l)
        blocks.append((norm(line_text(lines[i])).strip(), body))
    return blocks
