"""Parse stat-block entries (traits/actions/...) and retag SRD prose with inline markup."""
import re
from .extract import line_text
from .monsters import norm
from . import monsters

BOLDIT = 'Optima-BoldItalic'
ITALIC = 'Optima-Italic'
REGULAR = 'Optima-Regular'
BOLD = 'Optima-Bold'
SECTION_KEYS = {'Traits': 'trait', 'Actions': 'action', 'Bonus Actions': 'bonus',
                'Reactions': 'reaction', 'Legendary Actions': 'legendary'}

CONDITIONS = {'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled',
              'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone',
              'restrained', 'stunned', 'unconscious'}
SHAPES = {'Cone', 'Line', 'Sphere', 'Cube', 'Emanation', 'Cylinder'}
ABIL3 = {'Strength': 'str', 'Dexterity': 'dex', 'Constitution': 'con',
         'Intelligence': 'int', 'Wisdom': 'wis', 'Charisma': 'cha'}
KEYWORDS = {
    'Melee Attack Roll:': '{@atkr m}',
    'Ranged Attack Roll:': '{@atkr r}',
    'Melee or Ranged Attack Roll:': '{@atkr m,r}',
    'Hit:': '{@h}',
    'Hit or Miss:': 'Hit or Miss:',
    'Miss:': 'Miss:',
    'Failure:': '{@actSaveFail}',
    'Success:': '{@actSaveSuccess}',
    'Failure or Success:': '{@actSaveSuccessOrFail}',
    'First Failure:': '{@actSaveFail 1}',
    'Second Failure:': '{@actSaveFail 2}',
    'Third Failure:': '{@actSaveFail 3}',
    'Failure by 5 or More:': '{@actSaveFailBy 5}',
    'Trigger:': '{@actTrigger}',
    'Response:': '{@actResponse}',
    'Response—': '{@actResponse} ',
}


def wrap_join(pieces):
    """Join (font, text, x, x1) fragments; WRAP markers are PDF line breaks.

    Within a line the PDF encodes word spacing as an x-gap between spans, so a
    gap has to be restored as a space. Returns (text, fonts) with fonts[i] the
    font of text[i].
    """
    out, fonts = [], []

    def push(s, f):
        for ch in s:
            out.append(ch)
            fonts.append(f)

    pending_wrap = False
    prev_x1 = None
    for font, text, x, x1 in pieces:
        if font is None:            # WRAP marker
            pending_wrap = True
            prev_x1 = None
            continue
        text = norm(text)
        if not text:
            continue
        if not pending_wrap and prev_x1 is not None and x - prev_x1 > 1.2 \
                and out and not out[-1] == ' ' and not text.startswith(' '):
            push(' ', font)
        prev_x1 = x1
        if pending_wrap:
            pending_wrap = False
            cur = ''.join(out)
            if cur.endswith('-'):
                left = re.search(r"([A-Za-z][A-Za-z'-]*)-$", cur)
                right = re.match(r"([A-Za-z][A-Za-z'-]*)", text)
                if left and right:
                    vocab = monsters.VOCAB
                    merged = (left.group(1) + right.group(1)).lower()
                    kept = (left.group(1) + '-' + right.group(1)).lower()
                    if kept in vocab and merged not in vocab:
                        pass                       # genuine compound: keep the hyphen
                    elif merged in vocab or kept not in vocab:
                        out.pop()                  # soft hyphen from line wrapping
                        fonts.pop()
            elif cur and not cur.endswith(' ') and not text.startswith(' '):
                push(' ', font)
        push(text, font)
    text = ''.join(out)
    # collapse runs of whitespace, keeping the font map aligned
    keep = []
    for i, ch in enumerate(text):
        if ch == ' ' and i and text[i - 1] == ' ':
            continue
        keep.append(i)
    return ''.join(text[i] for i in keep), [fonts[i] for i in keep]


def split_entries(section_lines):
    """Split a section's lines into entries; returns [(name, [line,...]), ...]."""
    entries, cur = [], None
    preamble = []
    for l in section_lines:
        s0 = l['spans'][0]
        if s0['f'] == BOLDIT:
            cur = {'lines': [l]}
            entries.append(cur)
        elif cur is None:
            preamble.append(l)
        else:
            cur['lines'].append(l)
    return entries, preamble


def entry_pieces(lines):
    """Flatten an entry's lines into (font, text) fragments with WRAP markers,
    split into paragraphs on leading tabs."""
    paras, cur = [], []
    first = True
    for l in lines:
        raw = line_text(l)
        starts_para = bool(re.match(r'^\s*\t', raw)) and not first
        if starts_para and cur:
            paras.append(cur)
            cur = []
        if cur:
            cur.append((None, '', 0, 0))    # WRAP
        for s in l['spans']:
            cur.append((s['f'], s['t'], s['x'], s['x1']))
        first = False
    if cur:
        paras.append(cur)
    return paras


def strip_name(text, fonts):
    """Remove the leading bold-italic entry name; returns (name, rest, rest_fonts)."""
    n = 0
    while n < len(fonts) and fonts[n] == BOLDIT:
        n += 1
    name = text[:n].strip()
    rest, rf = text[n:], fonts[n:]
    # the name's trailing period belongs to the label, not the prose
    name = name.rstrip()
    if name.endswith('.'):
        name = name[:-1]
    while rest[:1] in (' ', '.'):
        rest, rf = rest[1:], rf[1:]
    return name.strip(), rest, rf


def tag_name(name):
    """'Acid Breath (Recharge 5-6)' -> 'Acid Breath {@recharge 5}'."""
    m = re.search(r'\s*\(Recharge\s+(\d+)(?:\s*[-–—]\s*\d+)?\)\s*$', name)
    if m:
        base = name[:m.start()].strip()
        return '%s {@recharge %s}' % (base, m.group(1)) if m.group(1) != '6' \
            else '%s {@recharge}' % base
    return name


def _dice_spans(text):
    """Index ranges of dice expressions, longest-first so '2d6 + 5' beats '2d6'."""
    return [(m.start(), m.end()) for m in
            re.finditer(r'\d+d\d+(?:\s*[+-]\s*\d+)?', text)]


KEYWORD_HEADS = tuple(sorted(KEYWORDS, key=len, reverse=True)) + (
    'Saving Throw:', 'Legendary Action Uses:')
# An italic run can end just before its colon when the label straddles a line
# break, leaving a bare rules word that must not be read as a spell name.
RULES_WORDS = {'hit', 'miss', 'failure', 'success', 'trigger', 'response',
               'hit or miss', 'failure or success', 'first failure',
               'second failure', 'third failure', 'saving throw',
               'subsequent failures', 'failure by 5 or more'}


def tag_spells(text, fonts):
    """Italic runs that are not rules keywords are spell names."""
    runs, i = [], 0
    while i < len(fonts):
        if fonts[i] != ITALIC:
            i += 1
            continue
        j = i
        while j < len(fonts) and fonts[j] == ITALIC:
            j += 1
        runs.append((i, j))
        i = j
    out = []
    last = 0
    for a, b in runs:
        frag = text[a:b]
        core = frag.strip()
        if not core or any(k in core for k in KEYWORD_HEADS) or re.match(
                r'^(%s)\b' % '|'.join(ABIL3), core):
            continue
        if core.rstrip(':').strip().lower() in RULES_WORDS:
            continue
        if text[b:b + 1] == ':':        # label whose colon fell outside the run
            continue
        m = re.match(r'^(.*?)\s*(\(level \d+ version\))?\s*([.,;:]?)\s*$', core, re.S)
        spell = (m.group(1) or '').strip().rstrip('.,;:')
        if not spell or not re.match(r"^[A-Z][A-Za-z'’ /-]*$", spell):
            continue
        lead = len(frag) - len(frag.lstrip())
        start = a + lead
        end = start + len(core)
        rebuilt = '{@spell %s}' % spell
        if m.group(2):
            rebuilt += ' ' + m.group(2)
        rebuilt += m.group(3) or ''
        out.append((start, end, rebuilt))
    if not out:
        return text
    res, prev = [], 0
    for start, end, rep in out:
        res.append(text[prev:start])
        res.append(rep)
        prev = end
    res.append(text[prev:])
    return ''.join(res)


def tag_prose(text, fonts):
    """Convert SRD stat-block prose into the tagged form the compiler parses."""
    text = tag_spells(text, fonts)
    # 1. keyword phrases (italic in the PDF) -> control tags
    for phrase in sorted(KEYWORDS, key=len, reverse=True):
        text = text.replace(phrase, '\x00%s\x00' % KEYWORDS[phrase])

    # 2. saving throws: "Constitution Saving Throw:" -> {@actSave con}
    def save_repl(m):
        return '\x00{@actSave %s}\x00' % ABIL3[m.group(1)]
    text = re.sub(r'\b(%s) Saving Throw:' % '|'.join(ABIL3), save_repl, text)

    # 3. DCs and attack bonuses
    text = re.sub(r'\bDC (\d+)', lambda m: '{@dc %s}' % m.group(1), text)
    text = re.sub(r'(\{@atkr [^}]*\}\x00)\s*([+-]\d+)',
                  lambda m: '%s {@hit %s}' % (m.group(1), m.group(2).lstrip('+')), text)

    # 4. dice -> {@damage} inside "N (XdY) <type> damage", else {@dice}
    def dice_repl(m):
        expr = re.sub(r'\s+', ' ', m.group(0))
        after = text[m.end():m.end() + 40]
        inside_paren = m.string[max(0, m.start() - 1):m.start()] == '('
        # "(2d6) Necrotic damage" and "(2d6) damage of the type chosen" are both
        # damage; "(5d10) days" is an ordinary roll.
        is_damage = inside_paren and re.match(r'\)\s*(?:[A-Z][a-z]+\s+)?damage', after)
        return '{@%s %s}' % ('damage' if is_damage else 'dice', expr)
    text = re.sub(r'\d+d\d+(?:\s*[+-]\s*\d+)?', dice_repl, text)

    text = text.replace('\x00', '')
    text = text.replace('{@h} ', '{@h}')
    # spell attack bonus in spellcasting headers: "+9 to hit with spell attacks"
    text = re.sub(r'([+-]\d+)(?=\s+to hit with spell attacks)',
                  lambda m: '{@hit %s}' % m.group(1).lstrip('+'), text)
    return text


SPELL_ABILITY = {'Strength': 'str', 'Dexterity': 'dex', 'Constitution': 'con',
                 'Intelligence': 'int', 'Wisdom': 'wis', 'Charisma': 'cha'}


def tag_spell_list(text):
    """'Acid Arrow (level 3 version), Detect Magic' -> ['{@spell Acid Arrow} (level 3 version)', ...]"""
    out = []
    for item in monsters.split_top(text, seps=',', strip_period=True):
        m = re.match(r'^(.*?)\s*(\(level \d+ version\))?$', item.strip())
        name = (m.group(1) or '').strip()
        if not name:
            continue
        ref = '{@spell %s}' % name
        if m.group(2):
            ref += ' ' + m.group(2)
        out.append(ref)
    return out


SPELL_REF = re.compile(r'\{@spell [^}]*\}(?:\s*\(level \d+ version\))?')


def is_cast_entry(rendered_text):
    """True for entries that are themselves a spell being cast.

    These are promoted to spellcasting blocks; the giveaway is the
    'using ... as the spellcasting ability' clause. Entries that merely say
    'uses Spellcasting to cast X' stay ordinary entries.
    """
    if 'spellcasting ability' not in rendered_text:
        return False
    if re.search(r'uses Spellcasting to cast', rendered_text):
        return False
    # The entry must itself be the act of casting ("The dragon casts Fear, ..."),
    # not a trait that merely refers to a spellcasting ability.
    return bool(re.match(r'^\s*(?:While[^.]{0,120}?,\s*)?[Tt]he [a-z][\w\' -]*?\s+(?:can\s+)?casts?\b',
                         rendered_text))


def build_cast_block(name, header, display_as):
    """Wrap a 'The X casts Y' entry as a spellcasting block."""
    joined = ' '.join(header)
    # A header may name the same spell twice ("casts Fireball ... can replace one
    # Fireball with ..."); keep the first mention, which carries the cast level.
    refs, seen = [], set()
    # Only a sentence that casts or replaces names a spell the creature casts. "The spell fails ... if the target is
    # under the effect of the Protection from Evil and Good spell" names a spell it does not.
    casting = ' '.join(s for s in re.split(r'(?<=\.)\s+', joined) if re.search(r'\bcasts?\b|\breplace\b', s))
    for ref in SPELL_REF.findall(casting):
        key = re.sub(r'^\{@spell\s+|\}.*$', '', ref).split('|')[0].strip().lower()
        if key in seen:
            continue
        seen.add(key)
        refs.append(ref)
    block = {'name': name, 'type': 'spellcasting', 'headerEntries': header}
    per_day = re.search(r'\((\d+)/Day', name)
    recharge = re.search(r'\{@recharge\s*(\d*)\}', name)
    if recharge:
        block['recharge'] = {recharge.group(1) or '6': refs}
    elif display_as == 'legendary':
        block['legendary'] = {'1': refs}
    elif per_day:
        block['daily'] = {per_day.group(1): refs}
    elif re.search(r'must finish a \{?@?[a-zA-Z ]*Long Rest', joined):
        block['restLong'] = {'1': refs}
    else:
        block['will'] = refs
    abil = re.search(r'using (%s) as (?:the )?spellcasting ability' % '|'.join(SPELL_ABILITY), joined)
    if abil:
        block['ability'] = SPELL_ABILITY[abil.group(1)]
    block['displayAs'] = display_as
    return block


def parse_spellcasting(lines, display_as):
    """Build the spellcasting block from a 'Spellcasting' entry's lines.

    The SRD renders the frequency buckets ('At Will:', '1/Day Each:') as bold
    lines following the header paragraph.
    """
    head_lines, bucket_lines = [], []
    for l in lines:
        s = l['spans'][0]
        if s['f'] == BOLD and re.match(r'^\s*(At Will|\d+/Day)\b', norm(line_text(l))):
            bucket_lines.append(l)
        elif bucket_lines:
            bucket_lines.append(l)
        else:
            head_lines.append(l)

    paras = entry_pieces(head_lines)
    header = []
    name = None
    for i, p in enumerate(paras):
        text, fonts = wrap_join(p)
        if i == 0:
            name, text, fonts = strip_name(text, fonts)
        t = tag_terms(tag_prose(text, fonts))
        header.append(re.sub(r'\s+', ' ', t).strip())

    block = {'name': name or 'Spellcasting', 'type': 'spellcasting',
             'headerEntries': header}
    # Group wrapped bucket lines back together, then join through wrap_join so a
    # spell hyphenated across the wrap ("En-/tangle") is reassembled.
    groups, cur = [], None
    for l in bucket_lines:
        s = l['spans'][0]
        txt = norm(line_text(l))
        if s['f'] == BOLD and re.match(r'^\s*(At Will|\d+/Day|Recharge)\b', txt):
            cur = [l]
            groups.append(cur)
        elif cur is not None:
            cur.append(l)
    daily = {}
    for g in groups:
        pieces = []
        for n, l in enumerate(g):
            if n:
                pieces.append((None, '', 0, 0))
            for s in l['spans']:
                pieces.append((s['f'], s['t'], s['x'], s['x1']))
        joined, _ = wrap_join(pieces)
        joined = re.sub(r'\s+', ' ', joined).strip()
        m = re.match(r'^At Will:\s*(.*)$', joined)
        if m:
            block['will'] = tag_spell_list(m.group(1))
            continue
        m = re.match(r'^(\d+)/Day(\s+Each)?:\s*(.*)$', joined)
        if m:
            key = m.group(1) + ('e' if m.group(2) else '')
            daily[key] = tag_spell_list(m.group(3))
            continue
        m = re.match(r'^Recharge\s+(\d+)(?:\s*[-–—]\s*\d+)?:\s*(.*)$', joined)
        if m:
            block.setdefault('recharge', {})[m.group(1)] = tag_spell_list(m.group(2))
    if daily:
        block['daily'] = daily
    abil = re.search(r'using (%s) as (?:the )?spellcasting ability' % '|'.join(SPELL_ABILITY),
                     ' '.join(header))
    if abil:
        block['ability'] = SPELL_ABILITY[abil.group(1)]
    block['displayAs'] = display_as
    return block


def tag_terms(text):
    """Tag conditions, area shapes and rules terms that the parsers key on."""
    # Conditions are capitalised rules terms wherever they appear, and the parsers
    # match on the tag rather than the bare word, so tag every occurrence.
    text = re.sub(r'\b(%s)\b' % '|'.join(
        sorted((c.capitalize() for c in CONDITIONS), key=len, reverse=True)),
        lambda m: '{@condition %s}' % m.group(1), text)
    # area shapes
    text = re.sub(r'\b(%s)\b' % '|'.join(SHAPES),
                  lambda m: '{@variantrule %s}' % m.group(1), text)
    # rules terms
    text = re.sub(r'\bHit Points\b', '{@variantrule Hit Points}', text)
    text = re.sub(r'\b(Advantage|Disadvantage)\b',
                  lambda m: '{@variantrule %s}' % m.group(1), text)
    text = re.sub(r'\bBloodied\b', '{@status Bloodied}', text)
    return text
