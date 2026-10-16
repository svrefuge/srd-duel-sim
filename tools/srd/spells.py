"""Parse SRD 5.2.1 spell descriptions out of the PDF into tagged JSON."""
import re
from . import monsters
from .monsters import norm
from .extract import line_text
from . import entries as E

NAME_FONT, NAME_SZ = 'GillSans-SemiBold', 12.0
META_FONT = 'Cambria-Italic'
LABEL_FONT, LABEL_SZ = 'GillSans-SemiBold', 9.5
BODY_FONT = 'Cambria'
HIGHER_FONT = 'Cambria-BoldItalic'

SCHOOLS = {'Abjuration': 'A', 'Conjuration': 'C', 'Divination': 'D', 'Enchantment': 'E',
           'Evocation': 'V', 'Illusion': 'I', 'Necromancy': 'N', 'Transmutation': 'T'}
ABILITIES = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma']
DAMAGE_TYPES = ['Acid', 'Bludgeoning', 'Cold', 'Fire', 'Force', 'Lightning', 'Necrotic',
                'Piercing', 'Poison', 'Psychic', 'Radiant', 'Slashing', 'Thunder']
SHAPES = ['Emanation', 'Cylinder', 'Sphere', 'Cone', 'Cube', 'Line', 'Wall']
META_RE = re.compile(
    r'^(?:Level (\d+) (%s)|(%s) Cantrip)\b' % ('|'.join(SCHOOLS), '|'.join(SCHOOLS)))
TIME_UNITS = ['round', 'minute', 'hour', 'day', 'week', 'month', 'year']


def parse_casting_time(text):
    """Keep canonical units and the complete trigger of a reaction spell."""
    match = re.match(r'^(?:(\d+)\s*)?(Action|Bonus Action|Reaction|Minute|Hour)s?\b', text, re.I)
    if not match:
        return [{'number': 1, 'unit': 'action'}]
    unit = match.group(2).lower()
    time = {'number': int(match.group(1) or 1), 'unit': 'bonus' if unit == 'bonus action' else unit}
    if unit == 'reaction':
        trigger = text[match.end():].strip().lstrip(',').strip()
        if trigger:
            time['condition'] = trigger
    return [time]


def find_spells(lines):
    """Locate spell descriptions: a 12pt name followed by a 'Level N School' line."""
    out = []
    for i, l in enumerate(lines[:-1]):
        s = l['spans'][0]
        # the first spell of the section is set in the small-caps variant
        if s['f'] not in (NAME_FONT, NAME_FONT + '-SC700') or abs(s['sz'] - NAME_SZ) > 0.2:
            continue
        nxt = lines[i + 1]
        if nxt['spans'][0]['f'] != META_FONT:
            continue
        if not META_RE.match(norm(line_text(nxt)).strip()):
            continue
        out.append(i)
    return out


def parse_range(text):
    text = text.strip().rstrip('.')
    # "Self (15-foot Cone)" carries the reach in the parenthetical; the compiler
    # measures spell range from distance.amount, so keep the number there.
    m = re.match(r'^Self\s*\((\d+)-(?:foot|mile)(?:-radius|-high|-long|-wide)?\s+([A-Za-z]+)',
                 text, re.I)
    if m:
        shape = m.group(2).lower()
        return {'type': shape if shape in [s.lower() for s in SHAPES] else 'point',
                'distance': {'type': 'feet', 'amount': int(m.group(1))}}
    if re.match(r'^Self\b', text, re.I):
        return {'type': 'point', 'distance': {'type': 'self'}}
    if re.match(r'^Touch\b', text, re.I):
        return {'type': 'point', 'distance': {'type': 'touch'}}
    if re.match(r'^Sight\b', text, re.I):
        return {'type': 'point', 'distance': {'type': 'sight'}}
    if re.match(r'^Unlimited\b', text, re.I):
        return {'type': 'point', 'distance': {'type': 'unlimited'}}
    m = re.match(r'^(\d+)\s*(feet|foot|ft\.?|miles?)\b', text, re.I)
    if m:
        unit = 'miles' if 'mile' in m.group(2).lower() else 'feet'
        return {'type': 'point', 'distance': {'type': unit, 'amount': int(m.group(1))}}
    return {'type': 'special', 'distance': {'type': 'special'}}


def parse_duration(text):
    text = text.strip().rstrip('.')
    conc = bool(re.match(r'^Concentration', text, re.I))
    body = re.sub(r'^Concentration,\s*up to\s*', '', text, flags=re.I)
    body = re.sub(r'^Up to\s*', '', body, flags=re.I)
    if re.match(r'^Instantaneous', body, re.I):
        return [{'type': 'instant'}] if not conc else [{'type': 'instant', 'concentration': True}]
    if re.match(r'^(Until dispelled|Permanent)', body, re.I):
        out = {'type': 'permanent', 'ends': ['dispel']}
        if conc:
            out['concentration'] = True
        return [out]
    m = re.match(r'^(\d+)\s*(%s)s?\b' % '|'.join(TIME_UNITS), body, re.I)
    if m:
        out = {'type': 'timed',
               'duration': {'type': m.group(2).lower(), 'amount': int(m.group(1))}}
        if conc:
            out['concentration'] = True
        return [out]
    out = {'type': 'special'}
    if conc:
        out['concentration'] = True
    return [out]


def tag_spell_text(text, all_damage=False):
    """Tag dice and area shapes the way the compiler's parsers expect.

    In the higher-level sections every roll is a damage increment, so the usual
    "followed by a damage type" test does not apply.
    """
    def dice_repl(m):
        if all_damage:
            return '{@damage %s}' % re.sub(r'\s+', ' ', m.group(0))
        expr = re.sub(r'\s+', ' ', m.group(0))
        after = m.string[m.end():m.end() + 46]
        before = m.string[:m.start()]
        if re.search(r'\btakes?\s+(?:%s)\s+damage equal to\s*$' % '|'.join(DAMAGE_TYPES), before):
            return '{@damage %s}' % expr
        # "8d6 Fire damage", "2d10 Bludgeoning damage", "1d4 damage"
        if re.match(r'\s+(?:%s)?\s*damage' % '|'.join(DAMAGE_TYPES), after) \
                or re.match(r'\s+(?:%s)\b' % '|'.join(DAMAGE_TYPES), after):
            return '{@damage %s}' % expr
        if re.match(r'\s*\)\s*(?:%s)?\s*damage' % '|'.join(DAMAGE_TYPES), after):
            return '{@damage %s}' % expr
        return '{@dice %s}' % expr
    text = re.sub(r'\d+d\d+(?:\s*[+-]\s*\d+)?', dice_repl, text)
    text = re.sub(r'\b(%s)\b' % '|'.join(SHAPES),
                  lambda m: '{@variantrule %s}' % m.group(1), text)
    text = re.sub(r'\bHit Points\b', '{@variantrule Hit Points}', text)
    text = re.sub(r'\b(Advantage|Disadvantage)\b',
                  lambda m: '{@variantrule %s}' % m.group(1), text)
    text = re.sub(r'\b(%s)\b' % '|'.join(sorted(
        (c.capitalize() for c in E.CONDITIONS), key=len, reverse=True)),
        lambda m: '{@condition %s}' % m.group(1), text)
    return text


def self_area_range(body_text):
    """For a Self-range spell, recover the reach from the area described in the text.

    The SRD prints only 'Range: Self'; the size lives in the description ('each
    creature in a 60-foot Cone originating from you'). The compiler measures
    spell reach from range.distance.amount, so it has to be carried there.
    """
    stripped = re.sub(r'\{@variantrule ([^}|]+)[^}]*\}', r'\1', body_text)
    m = re.search(r'(\d+)-(foot|mile)(?:-long|-radius|-high|-wide)?'
                  r'(?:,\s*\d+-foot-\w+)?\s+(%s)\b' % '|'.join(SHAPES), stripped)
    if m:
        return {'type': m.group(3).lower(),
                'distance': {'type': 'miles' if m.group(2) == 'mile' else 'feet',
                             'amount': int(m.group(1))}}
    return None


def derive(spell, body_text, higher_text):
    """Fill in the metadata stored alongside the printed text."""
    joined = body_text + ' ' + higher_text
    saves = []
    for m in re.finditer(r'\b(%s) saving throw' % '|'.join(ABILITIES), joined):
        a = m.group(1).lower()
        if a not in saves:
            saves.append(a)
    if saves:
        spell['savingThrow'] = saves

    # Only spells that actually roll damage inflict it; a spell that merely grants
    # resistance mentions damage types without dealing any.
    types = []
    # Some spells name the type before the roll ("takes Force damage equal to 1d8"),
    # so a {@damage} tag is not the only sign that a spell deals damage.
    deals = '{@damage' in joined or re.search(
        r'takes\s+(?:%s)\s+damage' % '|'.join(DAMAGE_TYPES), joined)
    if deals:
        for m in re.finditer(r'\{@damage [^}]*\}\s*(%s)?\s*damage' % '|'.join(DAMAGE_TYPES),
                             joined):
            if m.group(1):
                t = m.group(1).lower()
                if t not in types:
                    types.append(t)
        # "Choose Acid, Cold, ... or Thunder ... takes 3d8 damage of the chosen type"
        if not types and re.search(r'damage of the (?:chosen|same) type', joined, re.I):
            choose = re.search(r'Choose ((?:%s)(?:[,\s]+(?:or\s+)?(?:%s))*)'
                               % ('|'.join(DAMAGE_TYPES), '|'.join(DAMAGE_TYPES)), joined)
            if choose:
                for t in re.findall(r'|'.join(DAMAGE_TYPES), choose.group(1)):
                    if t.lower() not in types:
                        types.append(t.lower())
        if not types:
            for m in re.finditer(r'\b(%s) damage' % '|'.join(DAMAGE_TYPES), joined):
                t = m.group(1).lower()
                if t not in types:
                    types.append(t)
    if types:
        spell['damageInflict'] = sorted(types)

    if re.search(r'\branged spell attack\b', joined, re.I):
        spell['spellAttack'] = ['R']
    elif re.search(r'\bmelee spell attack\b', joined, re.I):
        spell['spellAttack'] = ['M']

    if spell['level'] == 0 and higher_text:
        # "The damage increases by 1d10 when you reach levels 5 (2d10), 11 (3d10), and 17 (4d10)."
        base = re.search(r'\{@damage (\d+d\d+)\}', body_text)
        tiers = re.findall(r'levels? (\d+) \(\{@damage (\d+d\d+)\}\)|,? and (\d+) \(\{@damage (\d+d\d+)\}\)',
                           higher_text)
        pairs = re.findall(r'(\d+)\s*\(\{@damage (\d+d\d+)\}\)', higher_text)
        if base and pairs:
            scaling = {'1': base.group(1)}
            for lvl, dice in pairs:
                scaling[lvl] = dice
            label = 'damage'
            lm = re.search(r'\{@damage \d+d\d+\}\s*(%s)?\s*damage' % '|'.join(DAMAGE_TYPES),
                           body_text)
            if lm and lm.group(1):
                label = '%s damage' % lm.group(1)
            spell['scalingLevelDice'] = {'label': label, 'scaling': scaling}
    return spell


def scale_higher(spell, body_text, higher_entries):
    """Keep healing scaling as scaledice and damage scaling as scaledamage."""
    lvl = spell['level']
    out = []
    for blk in higher_entries:
        new_entries = []
        for t in blk['entries']:
            def repl(m):
                verb, per = m.group(1), m.group(2)
                # base = the damage clause this increment applies to; the parsers only
                # read the per-level field, so this is for readability
                kind = re.search(r'\b(%s)\s+damage[^.]{0,40}$' % '|'.join(DAMAGE_TYPES),
                                 t[:m.start()])
                healing = bool(re.search(r'\b(?:healing|hit points)\b', t, re.I))
                pat = (r'\{@damage (\d+d\d+)\}\s*%s' % kind.group(1)) if kind \
                    else r'\{@(?:dice|damage) (\d+d\d+)\}' if healing \
                    else r'\{@damage (\d+d\d+)\}'
                bm = re.search(pat, body_text)
                base = bm.group(1) if bm else per
                return '%s by {@%s %s|%d-9|%s}' % (verb, 'scaledice' if healing else 'scaledamage', base, lvl, per)
            # "increases by 1d6", "increase by 1d6" (plural subject), and spells with
            # two separate increments in one sentence.
            t2 = re.sub(r'(increases?|increase) by \{@damage (\d+d\d+)\}', repl, t)
            new_entries.append(t2)
        out.append({'type': 'entries', 'name': blk['name'], 'entries': new_entries})
    return out


def build_all(lines, words):
    monsters.WORDS = words
    monsters.VOCAB = monsters.build_vocab(lines)
    starts = find_spells(lines)
    out = []
    for k, i in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(lines)
        # Stop at the next chapter/section heading so the final spell does not
        # absorb the rest of the document.
        for j in range(i + 1, end):
            s = lines[j]['spans'][0]
            if s['f'].startswith('GillSans-SemiBold') and s['sz'] >= 14:
                end = j
                break
        name = norm(line_text(lines[i])).strip()
        meta = norm(line_text(lines[i + 1])).strip()
        m = META_RE.match(meta)
        level = int(m.group(1)) if m.group(1) else 0
        school = SCHOOLS[m.group(2) or m.group(3)]

        # Bold italic marks both the trailing upgrade sections and in-body named
        # sub-effects ('Flood.', 'Part Water.'), so split on the label text.
        fields = {}
        current_field = None
        sections = [{'name': None, 'lines': []}]
        j = i + 2
        while j < end:
            l = lines[j]
            s = l['spans'][0]
            txt = norm(line_text(l))
            if s['f'] in (LABEL_FONT, 'GillSans-Bold', 'Cambria-Bold'):
                lm = re.match(r'^(Casting Time|Range|Components?|Duration):\s*(.*)$', txt)
                if lm:
                    fields[lm.group(1)] = lm.group(2)
                    current_field = lm.group(1)
                    j += 1
                    continue
            # Metadata wraps in GillSans; spell descriptions use Cambria.
            # Keep continuation lines with their label, especially reaction triggers.
            if current_field and all(sp['f'].startswith('GillSans') for sp in l['spans']):
                fields[current_field] += ' ' + txt.strip()
                j += 1
                continue
            current_field = None
            if s['f'] == HIGHER_FONT:
                label = ''
                for sp in l['spans']:
                    if sp['f'] != HIGHER_FONT:
                        break
                    label += sp['t']
                sections.append({'name': norm(label).strip().strip('.').strip(), 'lines': [l]})
            else:
                sections[-1]['lines'].append(l)
            j += 1

        UPGRADES = ('Using a Higher-Level Spell Slot', 'Cantrip Upgrade')
        body_sections = [s for s in sections if s['name'] not in UPGRADES]
        higher_sections = [s for s in sections if s['name'] in UPGRADES]

        spell = {'name': name, 'source': 'SRD', 'level': level, 'school': school}
        spell['components'] = {c.lower(): True for c in re.findall(r'\b[VSM]\b', fields.get('Components', fields.get('Component', '')).split('(')[0])}
        spell['time'] = parse_casting_time(fields.get('Casting Time', ''))
        spell['range'] = parse_range(fields.get('Range', ''))
        spell['duration'] = parse_duration(fields.get('Duration', ''))

        spell['entries'] = []
        for sec in body_sections:
            paras = strip_label(paragraphs(sec['lines']), sec['name'])
            texts = [p for p in (re.sub(r'\s+', ' ', tag_spell_text(t)).strip()
                                 for t in paras) if p]
            if not texts:
                continue
            if sec['name']:
                spell['entries'].append({'type': 'entries', 'name': sec['name'],
                                         'entries': texts})
            else:
                spell['entries'].extend(texts)

        higher_blocks = []
        for sec in higher_sections:
            paras = strip_label(paragraphs(sec['lines']), sec['name'])
            texts = [p for p in (re.sub(r'\s+', ' ', tag_spell_text(t, all_damage=True)).strip()
                                 for t in paras) if p]
            if texts:
                higher_blocks.append({'name': sec['name'], 'entries': texts})
        if higher_blocks:
            spell['entriesHigherLevel'] = scale_higher(
                spell, flat_text(spell['entries']), higher_blocks)

        if spell['range'].get('distance', {}).get('type') == 'self':
            area = self_area_range(flat_text(spell['entries']))
            if area:
                spell['range'] = area
        derive(spell, flat_text(spell['entries']),
               flat_text(spell.get('entriesHigherLevel', [])))
        out.append(spell)
    return out


def paragraphs(body_lines):
    """Join wrapped lines into paragraphs, splitting on the leading-tab indent."""
    paras, cur = [], []
    for l in body_lines:
        raw = line_text(l)
        if re.match(r'^\s*\t', raw) and cur:
            paras.append(cur)
            cur = []
        if cur:
            cur.append((None, '', 0, 0))
        for s in l['spans']:
            cur.append((s['f'], s['t'], s['x'], s['x1']))
    if cur:
        paras.append(cur)
    return [E.wrap_join(p)[0] for p in paras]


def flat_text(value):
    """Flatten nested entry structures into one string, like the compiler does."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ' '.join(flat_text(v) for v in value)
    if isinstance(value, dict):
        return ' '.join(flat_text(value.get(k)) for k in ('name', 'entries') if value.get(k))
    return ''


def strip_label(paras, label):
    """Remove a section's bold-italic label from the start of its first paragraph."""
    if not paras or not label:
        return paras
    first = paras[0].lstrip()
    if first.startswith(label):
        first = first[len(label):]
    paras = list(paras)
    paras[0] = first.lstrip('. ').strip()
    return paras


def split_higher(higher_lines):
    """Split the trailing bold-italic sections ('Cantrip Upgrade.', ...)."""
    blocks, cur = [], None
    for l in higher_lines:
        if l['spans'][0]['f'] == HIGHER_FONT:
            label = ''
            for s in l['spans']:
                if s['f'] != HIGHER_FONT:
                    break
                label += s['t']
            cur = {'name': norm(label).strip().strip('.').strip(), 'lines': [l]}
            blocks.append(cur)
        elif cur is not None:
            cur['lines'].append(l)
    out = []
    for b in blocks:
        paras = paragraphs(b['lines'])
        if paras:
            # drop the bold-italic label from the start of the first paragraph
            first = paras[0].lstrip()
            if first.startswith(b['name']):
                first = first[len(b['name']):]
            paras[0] = first.lstrip('. ').strip()
        out.append({'name': b['name'], 'paras': [p for p in paras if p]})
    return out
