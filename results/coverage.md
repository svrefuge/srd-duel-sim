# mcsim-srd Coverage

- Monsters: 330
- Compiled action options: 773
- Monsters with no damaging routine: 2
- Skipped/unparsed items: 262
- Parser audit findings: 0

## Top Skipped Reasons

| Count | Reason |
| ---: | --- |
| 207 | non-damage or unsupported spell |
| 24 | not an attack/save/autohit damaging action |
| 8 | unmodeled reaction: no duel-relevant effect |
| 7 | casting time 1 minute: cannot be cast in the fight |
| 4 | unmodeled trait: condition text |
| 3 | unmodeled trait: deals damage |
| 2 | no damaging action routine |
| 2 | save action has no parseable damage |
| 2 | cast on another creature: no ally in a duel |
| 1 | environment not modeled: needs a body of water in the area (no terrain in the duel) |
| 1 | later trigger not modeled (no persistent zone): the frigid-air sheet's Constitution save for Cold damage on moving through a destroyed section |
| 1 | environment not modeled: works only while the creature is underwater (the duel is on land) |

## Monsters With No Damaging Routine

- Shrieker Fungus (CR 0)
- Seahorse (CR 0)

## Parser Audit

None


## Per-Monster Skips

### Aboleth

- Aboleth.trait / Mucus Cloud: unmodeled trait: deals damage

### Adult Black Dragon

- Adult Black Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Adult Black Dragon.spellcasting / Speak with Dead: non-damage or unsupported spell

### Ancient Black Dragon

- Ancient Black Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Ancient Black Dragon.spellcasting / Create Undead: non-damage or unsupported spell
- Ancient Black Dragon.spellcasting / Speak with Dead: non-damage or unsupported spell

### Black Pudding

- Black Pudding.reaction / Split: unmodeled reaction: no duel-relevant effect

### Adult Blue Dragon

- Adult Blue Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Adult Blue Dragon.spellcasting / Mage Hand: non-damage or unsupported spell
- Adult Blue Dragon.spellcasting / Scrying: non-damage or unsupported spell
- Adult Blue Dragon.spellcasting / Sending: non-damage or unsupported spell

### Ancient Blue Dragon

- Ancient Blue Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Ancient Blue Dragon.spellcasting / Mage Hand: non-damage or unsupported spell
- Ancient Blue Dragon.spellcasting / Scrying: non-damage or unsupported spell
- Ancient Blue Dragon.spellcasting / Sending: non-damage or unsupported spell

### Adult Brass Dragon

- Adult Brass Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Adult Brass Dragon.spellcasting / Minor Illusion: non-damage or unsupported spell
- Adult Brass Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Adult Brass Dragon.spellcasting / Speak with Animals: non-damage or unsupported spell
- Adult Brass Dragon.spellcasting / Detect Thoughts: non-damage or unsupported spell
- Adult Brass Dragon.spellcasting / Control Weather: non-damage or unsupported spell

### Ancient Brass Dragon

- Ancient Brass Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Ancient Brass Dragon.spellcasting / Minor Illusion: non-damage or unsupported spell
- Ancient Brass Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Ancient Brass Dragon.spellcasting / Speak with Animals: non-damage or unsupported spell
- Ancient Brass Dragon.spellcasting / Control Weather: non-damage or unsupported spell
- Ancient Brass Dragon.spellcasting / Detect Thoughts: non-damage or unsupported spell

### Adult Bronze Dragon

- Adult Bronze Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Adult Bronze Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Adult Bronze Dragon.spellcasting / Speak with Animals: non-damage or unsupported spell
- Adult Bronze Dragon.spellcasting / Thaumaturgy: non-damage or unsupported spell
- Adult Bronze Dragon.spellcasting / Detect Thoughts: non-damage or unsupported spell
- Adult Bronze Dragon.spellcasting / Water Breathing: non-damage or unsupported spell

### Ancient Bronze Dragon

- Ancient Bronze Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Ancient Bronze Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Ancient Bronze Dragon.spellcasting / Speak with Animals: non-damage or unsupported spell
- Ancient Bronze Dragon.spellcasting / Thaumaturgy: non-damage or unsupported spell
- Ancient Bronze Dragon.spellcasting / Detect Thoughts: non-damage or unsupported spell
- Ancient Bronze Dragon.spellcasting / Control Water: environment not modeled: needs a body of water in the area (no terrain in the duel)
- Ancient Bronze Dragon.spellcasting / Scrying: non-damage or unsupported spell
- Ancient Bronze Dragon.spellcasting / Water Breathing: non-damage or unsupported spell

### Cloud Giant

- Cloud Giant.spellcasting / Detect Magic: non-damage or unsupported spell
- Cloud Giant.spellcasting / Fog Cloud: non-damage or unsupported spell
- Cloud Giant.spellcasting / Light: non-damage or unsupported spell
- Cloud Giant.spellcasting / Control Weather: non-damage or unsupported spell
- Cloud Giant.spellcasting / Gaseous Form: non-damage or unsupported spell

### Adult Copper Dragon

- Adult Copper Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Adult Copper Dragon.spellcasting / Minor Illusion: non-damage or unsupported spell
- Adult Copper Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Adult Copper Dragon.spellcasting / Major Image: non-damage or unsupported spell

### Ancient Copper Dragon

- Ancient Copper Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Ancient Copper Dragon.spellcasting / Minor Illusion: non-damage or unsupported spell
- Ancient Copper Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Ancient Copper Dragon.spellcasting / Major Image: non-damage or unsupported spell
- Ancient Copper Dragon.spellcasting / Project Image: non-damage or unsupported spell

### Couatl

- Couatl.spellcasting / Detect Evil and Good: non-damage or unsupported spell
- Couatl.spellcasting / Detect Magic: non-damage or unsupported spell
- Couatl.spellcasting / Detect Thoughts: non-damage or unsupported spell
- Couatl.spellcasting / Shapechange: non-damage or unsupported spell
- Couatl.spellcasting / Create Food and Water: non-damage or unsupported spell
- Couatl.spellcasting / Dream: casting time 1 minute: cannot be cast in the fight
- Couatl.spellcasting / Scrying: non-damage or unsupported spell

### Cultist Fanatic

- Cultist Fanatic.spellcasting / Light: non-damage or unsupported spell
- Cultist Fanatic.spellcasting / Thaumaturgy: non-damage or unsupported spell

### Deva

- Deva.spellcasting / Detect Evil and Good: non-damage or unsupported spell
- Deva.spellcasting / Shapechange: non-damage or unsupported spell
- Deva.spellcasting / Commune: non-damage or unsupported spell
- Deva.spellcasting / Raise Dead: non-damage or unsupported spell
- Deva.spellcasting / Remove Curse: non-damage or unsupported spell

### Djinni

- Djinni.spellcasting / Detect Evil and Good: non-damage or unsupported spell
- Djinni.spellcasting / Detect Magic: non-damage or unsupported spell
- Djinni.spellcasting / Create Food and Water: non-damage or unsupported spell
- Djinni.spellcasting / Tongues: non-damage or unsupported spell
- Djinni.spellcasting / Wind Walk: non-damage or unsupported spell
- Djinni.spellcasting / Creation: non-damage or unsupported spell
- Djinni.spellcasting / Gaseous Form: non-damage or unsupported spell
- Djinni.spellcasting / Major Image: non-damage or unsupported spell
- Djinni.spellcasting / Plane Shift: non-damage or unsupported spell

### Doppelganger

- Doppelganger.bonus / Shape-Shift: not an attack/save/autohit damaging action
- Doppelganger.spellcasting / Detect Thoughts: non-damage or unsupported spell

### Drider

- Drider.spellcasting / Darkness: non-damage or unsupported spell

### Druid

- Druid.spellcasting / Druidcraft: non-damage or unsupported spell
- Druid.spellcasting / Speak with Animals: non-damage or unsupported spell
- Druid.spellcasting / Animal Messenger: non-damage or unsupported spell
- Druid.spellcasting / Longstrider: non-damage or unsupported spell

### Dryad

- Dryad.bonus / Tree Stride: not an attack/save/autohit damaging action
- Dryad.spellcasting / Animal Friendship: non-damage or unsupported spell
- Dryad.spellcasting / Druidcraft: non-damage or unsupported spell
- Dryad.spellcasting / Pass without Trace: non-damage or unsupported spell

### Efreeti

- Efreeti.spellcasting / Detect Magic: non-damage or unsupported spell
- Efreeti.spellcasting / Elementalism: non-damage or unsupported spell
- Efreeti.spellcasting / Gaseous Form: non-damage or unsupported spell
- Efreeti.spellcasting / Major Image: non-damage or unsupported spell
- Efreeti.spellcasting / Plane Shift: non-damage or unsupported spell
- Efreeti.spellcasting / Tongues: non-damage or unsupported spell

### Fire Elemental

- Fire Elemental.trait / Water Susceptibility: unmodeled trait: deals damage

### Shrieker Fungus

- Shrieker Fungus.action / Shrieker Fungus: no damaging action routine
- Shrieker Fungus.reaction / Shriek: unmodeled reaction: no duel-relevant effect

### Gelatinous Cube

- Gelatinous Cube.trait / Ooze Cube: unmodeled trait: deals damage

### Ghost

- Ghost.spellcasting / Etherealness: non-damage or unsupported spell

### Glabrezu

- Glabrezu.spellcasting / Darkness: non-damage or unsupported spell
- Glabrezu.spellcasting / Detect Magic: non-damage or unsupported spell

### Goblin Boss

- Goblin Boss.reaction / Redirect Attack: unmodeled reaction: no duel-relevant effect

### Adult Gold Dragon

- Adult Gold Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Adult Gold Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Adult Gold Dragon.spellcasting / Zone of Truth: non-damage or unsupported spell

### Ancient Gold Dragon

- Ancient Gold Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Ancient Gold Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Ancient Gold Dragon.spellcasting / Word of Recall: non-damage or unsupported spell
- Ancient Gold Dragon.spellcasting / Zone of Truth: non-damage or unsupported spell

### Adult Green Dragon

- Adult Green Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Adult Green Dragon.spellcasting / Geas: casting time 1 minute: cannot be cast in the fight

### Ancient Green Dragon

- Ancient Green Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Ancient Green Dragon.spellcasting / Geas: casting time 1 minute: cannot be cast in the fight
- Ancient Green Dragon.spellcasting / Modify Memory: non-damage or unsupported spell

### Green Hag

- Green Hag.spellcasting / Dancing Lights: non-damage or unsupported spell
- Green Hag.spellcasting / Disguise Self: non-damage or unsupported spell
- Green Hag.spellcasting / Minor Illusion: non-damage or unsupported spell

### Guardian Naga

- Guardian Naga.spellcasting / Thaumaturgy: non-damage or unsupported spell
- Guardian Naga.spellcasting / Clairvoyance: non-damage or unsupported spell
- Guardian Naga.spellcasting / Geas: casting time 1 minute: cannot be cast in the fight

### Ice Devil

- Ice Devil.spellcasting / Wall of Ice: later trigger not modeled (no persistent zone): the frigid-air sheet's Constitution save for Cold damage on moving through a destroyed section

### Imp

- Imp.action / Shape-Shift: not an attack/save/autohit damaging action

### Incubus

- Incubus.spellcasting / Disguise Self: non-damage or unsupported spell
- Incubus.spellcasting / Etherealness: non-damage or unsupported spell
- Incubus.spellcasting / Dream: casting time 1 minute: cannot be cast in the fight

### Kraken

- Kraken.legendary / Toxic Ink: environment not modeled: works only while the creature is underwater (the duel is on land)

### Lamia

- Lamia.spellcasting / Disguise Self: non-damage or unsupported spell
- Lamia.spellcasting / Minor Illusion: non-damage or unsupported spell
- Lamia.spellcasting / Geas: casting time 1 minute: cannot be cast in the fight
- Lamia.spellcasting / Major Image: non-damage or unsupported spell
- Lamia.spellcasting / Scrying: non-damage or unsupported spell

### Lich

- Lich.spellcasting / Detect Magic: non-damage or unsupported spell
- Lich.spellcasting / Detect Thoughts: non-damage or unsupported spell
- Lich.spellcasting / Mage Hand: non-damage or unsupported spell
- Lich.spellcasting / Prestidigitation: non-damage or unsupported spell
- Lich.spellcasting / Animate Dead: non-damage or unsupported spell
- Lich.spellcasting / Plane Shift: non-damage or unsupported spell
- Lich.spellcasting / Scrying: non-damage or unsupported spell

### Mage

- Mage.spellcasting / Detect Magic: non-damage or unsupported spell
- Mage.spellcasting / Light: non-damage or unsupported spell
- Mage.spellcasting / Mage Armor: non-damage or unsupported spell
- Mage.spellcasting / Mage Hand: non-damage or unsupported spell
- Mage.spellcasting / Prestidigitation: non-damage or unsupported spell

### Archmage

- Archmage.spellcasting / Detect Magic: non-damage or unsupported spell
- Archmage.spellcasting / Detect Thoughts: non-damage or unsupported spell
- Archmage.spellcasting / Disguise Self: non-damage or unsupported spell
- Archmage.spellcasting / Light: non-damage or unsupported spell
- Archmage.spellcasting / Mage Armor: non-damage or unsupported spell
- Archmage.spellcasting / Mage Hand: non-damage or unsupported spell
- Archmage.spellcasting / Prestidigitation: non-damage or unsupported spell
- Archmage.spellcasting / Mind Blank: non-damage or unsupported spell
- Archmage.spellcasting / Scrying: non-damage or unsupported spell
- Archmage.spellcasting / Teleport: non-damage or unsupported spell

### Magmin

- Magmin.bonus / Ignited Illumination: not an attack/save/autohit damaging action

### Ice Mephit

- Ice Mephit.spellcasting / Fog Cloud: non-damage or unsupported spell

### Mimic

- Mimic.bonus / Shape-Shift: not an attack/save/autohit damaging action
- Mimic.trait / Adhesive (Object Form Only): unmodeled trait: condition text

### Mummy Lord

- Mummy Lord.spellcasting / Thaumaturgy: non-damage or unsupported spell
- Mummy Lord.spellcasting / Animate Dead: non-damage or unsupported spell

### Night Hag

- Night Hag.bonus / Shape-Shift: not an attack/save/autohit damaging action
- Night Hag.spellcasting / Dream: casting time 1 minute: cannot be cast in the fight
- Night Hag.spellcasting / Detect Magic: non-damage or unsupported spell
- Night Hag.spellcasting / Etherealness: non-damage or unsupported spell
- Night Hag.spellcasting / Plane Shift: non-damage or unsupported spell

### Nightmare

- Nightmare.action / Ethereal Stride: not an attack/save/autohit damaging action

### Ochre Jelly

- Ochre Jelly.reaction / Split: unmodeled reaction: no duel-relevant effect

### Oni

- Oni.action / Shape-Shift: not an attack/save/autohit damaging action
- Oni.spellcasting / Darkness: non-damage or unsupported spell
- Oni.spellcasting / Gaseous Form: non-damage or unsupported spell

### Phase Spider

- Phase Spider.bonus / Ethereal Jaunt: not an attack/save/autohit damaging action

### Planetar

- Planetar.spellcasting / Detect Evil and Good: non-damage or unsupported spell
- Planetar.spellcasting / Commune: non-damage or unsupported spell
- Planetar.spellcasting / Control Weather: non-damage or unsupported spell
- Planetar.spellcasting / Raise Dead: non-damage or unsupported spell
- Planetar.spellcasting / Remove Curse: non-damage or unsupported spell

### Priest Acolyte

- Priest Acolyte.spellcasting / Light: non-damage or unsupported spell
- Priest Acolyte.spellcasting / Thaumaturgy: non-damage or unsupported spell

### Priest

- Priest.spellcasting / Light: non-damage or unsupported spell
- Priest.spellcasting / Thaumaturgy: non-damage or unsupported spell

### Quasit

- Quasit.action / Shape-Shift: not an attack/save/autohit damaging action

### Rakshasa

- Rakshasa.spellcasting / Detect Magic: non-damage or unsupported spell
- Rakshasa.spellcasting / Detect Thoughts: non-damage or unsupported spell
- Rakshasa.spellcasting / Disguise Self: non-damage or unsupported spell
- Rakshasa.spellcasting / Mage Hand: non-damage or unsupported spell
- Rakshasa.spellcasting / Minor Illusion: non-damage or unsupported spell
- Rakshasa.spellcasting / Major Image: non-damage or unsupported spell
- Rakshasa.spellcasting / Plane Shift: non-damage or unsupported spell

### Adult Red Dragon

- Adult Red Dragon.spellcasting / Detect Magic: non-damage or unsupported spell

### Ancient Red Dragon

- Ancient Red Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Ancient Red Dragon.spellcasting / Scrying: non-damage or unsupported spell

### Rust Monster

- Rust Monster.action / Antennae: save action has no parseable damage
- Rust Monster.action / Destroy Metal: not an attack/save/autohit damaging action
- Rust Monster.reaction / Reflexive Antennae: unmodeled reaction: no duel-relevant effect

### Sahuagin Warrior

- Sahuagin Warrior.bonus / Aquatic Charge: not an attack/save/autohit damaging action

### Sea Hag

- Sea Hag.spellcasting / Disguise Self: non-damage or unsupported spell

### Shadow

- Shadow.bonus / Shadow Stealth: not an attack/save/autohit damaging action

### Shield Guardian

- Shield Guardian.reaction / Protection: unmodeled reaction: no duel-relevant effect

### Adult Silver Dragon

- Adult Silver Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Adult Silver Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Adult Silver Dragon.spellcasting / Zone of Truth: non-damage or unsupported spell

### Ancient Silver Dragon

- Ancient Silver Dragon.spellcasting / Detect Magic: non-damage or unsupported spell
- Ancient Silver Dragon.spellcasting / Shapechange: non-damage or unsupported spell
- Ancient Silver Dragon.spellcasting / Control Weather: non-damage or unsupported spell
- Ancient Silver Dragon.spellcasting / Teleport: non-damage or unsupported spell
- Ancient Silver Dragon.spellcasting / Zone of Truth: non-damage or unsupported spell

### Solar

- Solar.spellcasting / Detect Evil and Good: non-damage or unsupported spell
- Solar.spellcasting / Commune: non-damage or unsupported spell
- Solar.spellcasting / Control Weather: non-damage or unsupported spell
- Solar.spellcasting / Resurrection: non-damage or unsupported spell
- Solar.spellcasting / Remove Curse: non-damage or unsupported spell

### Sphinx of Lore

- Sphinx of Lore.spellcasting / Detect Magic: non-damage or unsupported spell
- Sphinx of Lore.spellcasting / Identify: non-damage or unsupported spell
- Sphinx of Lore.spellcasting / Mage Hand: non-damage or unsupported spell
- Sphinx of Lore.spellcasting / Minor Illusion: non-damage or unsupported spell
- Sphinx of Lore.spellcasting / Prestidigitation: non-damage or unsupported spell
- Sphinx of Lore.spellcasting / Legend Lore: non-damage or unsupported spell
- Sphinx of Lore.spellcasting / Locate Object: non-damage or unsupported spell
- Sphinx of Lore.spellcasting / Plane Shift: non-damage or unsupported spell
- Sphinx of Lore.spellcasting / Remove Curse: non-damage or unsupported spell
- Sphinx of Lore.spellcasting / Tongues: non-damage or unsupported spell

### Sphinx of Valor

- Sphinx of Valor.spellcasting / Detect Evil and Good: non-damage or unsupported spell
- Sphinx of Valor.spellcasting / Thaumaturgy: non-damage or unsupported spell
- Sphinx of Valor.spellcasting / Detect Magic: non-damage or unsupported spell
- Sphinx of Valor.spellcasting / Heroes' Feast: non-damage or unsupported spell
- Sphinx of Valor.spellcasting / Zone of Truth: non-damage or unsupported spell

### Spirit Naga

- Spirit Naga.spellcasting / Detect Magic: non-damage or unsupported spell
- Spirit Naga.spellcasting / Mage Hand: non-damage or unsupported spell
- Spirit Naga.spellcasting / Minor Illusion: non-damage or unsupported spell
- Spirit Naga.spellcasting / Water Breathing: non-damage or unsupported spell
- Spirit Naga.spellcasting / Detect Thoughts: non-damage or unsupported spell

### Sprite

- Sprite.action / Heart Sight: save action has no parseable damage

### Storm Giant

- Storm Giant.spellcasting / Detect Magic: non-damage or unsupported spell
- Storm Giant.spellcasting / Light: non-damage or unsupported spell
- Storm Giant.spellcasting / Control Weather: non-damage or unsupported spell

### Succubus

- Succubus.bonus / Shape-Shift: not an attack/save/autohit damaging action

### Treant

- Treant.action / Animate Trees (1/Day): not an attack/save/autohit damaging action

### Unicorn

- Unicorn.spellcasting / Detect Evil and Good: non-damage or unsupported spell
- Unicorn.spellcasting / Druidcraft: non-damage or unsupported spell
- Unicorn.spellcasting / Calm Emotions: non-damage or unsupported spell
- Unicorn.spellcasting / Pass without Trace: non-damage or unsupported spell
- Unicorn.spellcasting / Word of Recall: non-damage or unsupported spell
- Unicorn.spellcasting / Cure Wounds: cast on another creature: no ally in a duel
- Unicorn.spellcasting / Lesser Restoration: cast on another creature: no ally in a duel

### Vampire Spawn

- Vampire Spawn.trait / Vampire Weakness: unmodeled trait: condition text

### Vampire

- Vampire.bonus / Shape-Shift: not an attack/save/autohit damaging action
- Vampire.trait / Misty Escape: unmodeled trait: condition text
- Vampire.trait / Vampire Weakness: unmodeled trait: condition text

### Werebear

- Werebear.bonus / Shape-Shift: not an attack/save/autohit damaging action

### Wereboar

- Wereboar.bonus / Shape-Shift: not an attack/save/autohit damaging action

### Wererat

- Wererat.bonus / Shape-Shift: not an attack/save/autohit damaging action

### Weretiger

- Weretiger.bonus / Shape-Shift: not an attack/save/autohit damaging action

### Werewolf

- Werewolf.bonus / Shape-Shift: not an attack/save/autohit damaging action

### Wraith

- Wraith.action / Create Specter: not an attack/save/autohit damaging action

### Giant Octopus

- Giant Octopus.reaction / Ink Cloud (1/Day): unmodeled reaction: no duel-relevant effect

### Giant Owl

- Giant Owl.spellcasting / Detect Evil and Good: non-damage or unsupported spell
- Giant Owl.spellcasting / Detect Magic: non-damage or unsupported spell
- Giant Owl.spellcasting / Clairvoyance: non-damage or unsupported spell

### Giant Seahorse

- Giant Seahorse.bonus / Bubble Dash: not an attack/save/autohit damaging action

### Octopus

- Octopus.reaction / Ink Cloud (1/Day): unmodeled reaction: no duel-relevant effect

### Seahorse

- Seahorse.action / Bubble Dash: not an attack/save/autohit damaging action
- Seahorse.action / Seahorse: no damaging action routine
