"""Extractor contract regression tests; run after installing tools/requirements.txt."""
import unittest
from srd import spells, bestiary, entries


def line(font, text, size=9.5):
    return {'p': 0, 'col': 0, 'y': 0, 'spans': [
        {'f': font, 't': text, 'sz': size, 'x': 30, 'x1': 300}]}


class ExtractionContract(unittest.TestCase):
    def test_spell_components_and_singular_component_label(self):
        for label, font in [('Components', spells.LABEL_FONT), ('Component', 'Cambria-Bold'), ('Components', 'GillSans-Bold')]:
            lines = [line(spells.NAME_FONT, 'Example', 12),
                     line(spells.META_FONT, 'Level 1 Evocation'),
                     line(spells.LABEL_FONT, 'Casting Time: Action'),
                     line(spells.LABEL_FONT, 'Range: 60 feet'),
                     line(font, label + ': V, S, M (a crystal)'),
                     line(spells.LABEL_FONT, 'Duration: Instantaneous'),
                     line(spells.BODY_FONT, 'The target takes 1d6 Fire damage.')]
            spell = spells.build_all(lines, [])[0]
            self.assertEqual(spell['components'], {'v': True, 's': True, 'm': True})
            self.assertEqual(spell['range']['distance']['amount'], 60)

    def test_casting_times(self):
        self.assertEqual(spells.parse_casting_time('Bonus Action'), [{'number': 1, 'unit': 'bonus'}])
        self.assertEqual(spells.parse_casting_time('1 minute'), [{'number': 1, 'unit': 'minute'}])
        self.assertEqual(spells.parse_casting_time('Action'), [{'number': 1, 'unit': 'action'}])

    def test_wrapped_reaction_trigger_stays_out_of_description(self):
        lines = [line(spells.NAME_FONT, 'Hellish Rebuke', 12),
                 line(spells.META_FONT, 'Level 1 Evocation'),
                 line(spells.LABEL_FONT, 'Casting Time: Reaction, which you take in response to'),
                 line('GillSans', 'taking damage from a creature that you can see within'),
                 line('GillSans', '60 feet of yourself'),
                 line(spells.LABEL_FONT, 'Range: 60 feet'),
                 line(spells.LABEL_FONT, 'Duration: Instantaneous'),
                 line(spells.BODY_FONT, 'The creature takes 2d10 Fire damage.')]
        spell = spells.build_all(lines, [])[0]
        self.assertEqual(spell['time'][0]['condition'],
                         'which you take in response to taking damage from a creature that you can see within 60 feet of yourself')
        self.assertEqual(spell['entries'], ['The creature takes {@damage 2d10} Fire damage.'])

    def test_healing_and_damage_scaling_are_distinct(self):
        for noun, tag, base in [('healing', 'scaledice', '{@dice 2d8}'),
                                ('damage', 'scaledamage', '{@damage 2d8}')]:
            out = spells.scale_higher({'level': 1}, base, [{
                'name': 'Using a Higher-Level Spell Slot',
                'entries': ['The %s increases by {@damage 2d8} for each spell slot level above 1.' % noun]}])
            self.assertIn('{@%s 2d8|1-9|2d8}' % tag, str(out))

    def test_damage_named_before_die_is_tagged_as_damage(self):
        text = 'The target takes Force damage equal to 1d8 plus your spellcasting ability modifier.'
        self.assertIn('{@damage 1d8}', spells.tag_spell_text(text))
        self.assertIn('{@dice 2d8}', spells.tag_spell_text('The creature regains 2d8 Hit Points.'))
        self.assertIn('{@dice 1d8}', spells.tag_spell_text('Roll 1d8 on the table.'))

    def test_sequence_structure_and_negative_control(self):
        text = 'Whenever it roars, the roar has a different effect: First Roar. Fear. Second Roar. Paralysis. Third Roar. Damage.'
        record = bestiary.render('Roar (3/Day)', [(text, [entries.REGULAR] * len(text))])
        self.assertEqual([i['name'] for i in record['entries'][1]['items']],
                         ['First Roar', 'Second Roar', 'Third Roar'])
        plain = text[text.index('First Roar.'):]
        self.assertTrue(all(isinstance(e, str) for e in bestiary.render('Roar', [(plain, [entries.REGULAR] * len(plain))])['entries']))

    def test_only_explicit_borrowing_inherits_and_explicit_ability_wins(self):
        rec = {'spellcasting': [
            {'name': 'Spellcasting', 'ability': 'wis'},
            {'name': 'Borrowed', 'headerEntries': ['using the same spellcasting ability as Spellcasting']},
            {'name': 'Unrelated', 'headerEntries': ['casts a spell']},
            {'name': 'Explicit', 'ability': 'cha', 'headerEntries': ['using the same spellcasting ability as Spellcasting']}]}
        bestiary.inherit_spellcasting_abilities(rec)
        self.assertEqual(rec['spellcasting'][1]['ability'], 'wis')
        self.assertNotIn('ability', rec['spellcasting'][2])
        self.assertEqual(rec['spellcasting'][3]['ability'], 'cha')

    def test_cast_block_lists_only_spells_the_entry_casts(self):
        header = ['While on the Ethereal Plane, the hag casts {@spell Dream}, using the same spellcasting ability as Spellcasting. '
                  'The spell fails and is wasted if the target is under the effect of the {@spell Protection from Evil and Good} spell or within a {@spell Magic Circle} spell.']
        block = entries.build_cast_block('Nightmare Haunting (1/Day; Requires Soul Bag)', header, 'action')
        self.assertEqual(block['daily'], {'1': ['{@spell Dream}']})
        # Negative control: a replacement sentence still names spells the creature casts.
        twice = ['The pit fiend casts {@spell Fireball} (level 5 version) twice. It can replace one {@spell Fireball} with {@spell Hold Monster} (level 7 version) or {@spell Wall of Fire}.']
        refs = entries.build_cast_block('Hellfire Spellcasting ({@recharge 4})', twice, 'action')['recharge']['4']
        self.assertEqual(refs, ['{@spell Fireball} (level 5 version)', '{@spell Hold Monster} (level 7 version)', '{@spell Wall of Fire}'])



if __name__ == '__main__':
    unittest.main()
