// Hasten, Rakshasa saves, Reflective Carapace, Burning, Fire Aversion, Power Word Stun, Slow, Counterspell, Pursuit,
// Charge and Leap. Each test is written from the printed SRD 5.2.1 text quoted above it; the finding id is in the
// test name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileAll, compileMonster } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e, rollEffectForTest as rolls } from '../src/engine/fight.ts';
import { actionEv } from '../src/engine/pairContext.ts';
import type { AttackAction, CombatAction, CombatStatblock } from '../src/types.ts';
const blocks = compileAll();
const block = (name: string) => blocks.find(b => b.name === name)!;
const option = (b: CombatStatblock, name: string) => b.options.find(o => o.name === name)!;
const fixed = () => .4;
const log = () => new FightLog(true);
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), ac: 0, hpAvg: 1000, options: [], routines: [], reaction: undefined, counterspell: undefined, ...changes });
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
const hit = (type = 'piercing'): AttackAction => ({ kind: 'attack', damage: [{ dice: { n: 0, d: 1, mod: 10 }, type }], toHit: 100, magical: false, melee: true, ranged: false, reach: 5, riders: [] });
function setup(name: string, foe = tank()) { const owner = block(name); return { owner, foe, a: e.initState(owner), b: e.initState(foe), g: at(5), l: log(), ev: e.createPairEvaluator(owner, foe, true) }; }
function use(x: ReturnType<typeof setup>, name: string, rng = fixed) { e.resolveOptionWithTeleport(x.owner, x.foe, x.a, x.b, option(x.owner, name).action, rng, 0, x.g, x.l, x.ev); }

test('Hasten pays its bonus slot and recharge; Clay Golem alternates three and two Slams when recharge fails', () => {
 const x = setup('Clay Golem');
 e.takeTurn([x.owner,x.foe],[x.a,x.b],0,fixed,x.g,x.l,x.ev,false);
 assert.equal(x.l.lines.filter(s=>s==='Clay Golem uses Slam').length,3);
 assert.equal(x.a.bonusSlotUsed,true); assert.ok(!x.a.conditions.some(c=>c.name==='hastened'));
 const before=x.l.lines.length;e.takeTurn([x.owner,x.foe],[x.a,x.b],0,fixed,x.g,x.l,x.ev,false);
 assert.equal(x.l.lines.slice(before).filter(s=>s==='Clay Golem uses Slam').length,2);
});
test('unhastened Clay Golem cannot choose the three-attack routine',()=>{
 const x=setup('Clay Golem');const c=e.bestUsableRoutinesAtDistance(x.owner,x.foe,x.a,x.b,0,5,x.ev);
 assert.equal(c.any.routine?.parts[0].count,2);
});
test('Rakshasa automatically saves even while Stunned; half-on-success damage still lands',()=>{
 const source=tank(),defender=block('Rakshasa'),a=e.initState(source),b=e.initState(defender);
 b.conditions.push({name:'stunned',duration:'permanent',source:0,appliedTurn:0});
 const save:CombatAction={kind:'save',ability:'dex',dc:100,magical:true,damage:[{dice:{n:0,d:1,mod:20},type:'fire'}],onSuccess:'half',riders:[{condition:'prone',duration:'permanent'}]};
 e.resolveAction(source,defender,a,b,save,()=>0,0,5,log());assert.equal(b.hp,defender.hpAvg-10);assert.ok(!b.conditions.some(c=>c.name==='prone'));
 assert.equal(actionEv(save,source,defender),10);
 assert.equal(e.rollSave(defender,b,'dex',100,false,()=>0),false);
});
test('Rakshasa spell attacks automatically miss, but Acid Arrow retains its explicit miss splash',()=>{
 const source=block('Adult Black Dragon'),defender=block('Rakshasa'),a=e.initState(source),b=e.initState(defender);
 const attack:CombatAction={...hit('force'),spell:true,ranged:true,melee:false};
 e.resolveAction(source,defender,a,b,attack,()=>.99,0,5,log());assert.equal(b.hp,defender.hpAvg);assert.equal(actionEv(attack,source,defender),0);
 const arrow=option(source,'Acid Arrow').action;e.resolveAction(source,defender,a,b,arrow,fixed,0,20,log());
 assert.equal(b.hp,defender.hpAvg-5);assert.equal(b.conditions.length,0);assert.equal(actionEv(arrow,source,defender),6.25);
});
test('Reflective Carapace blocks all eligible spells, reflects on six, and does not affect ordinary ranged weapons',()=>{
 const source=tank({ac:0}),defender=block('Tarrasque');
 const missile:CombatAction={kind:'autohit',magical:true,spell:true,spellName:'Magic Missile',range:120,damage:[{dice:{n:0,d:1,mod:10},type:'force'}]};
 for(const rng of [()=>0,()=>.99]){const a=e.initState(source),b=e.initState(defender);e.resolveAction(source,defender,a,b,missile,rng,0,30,log());assert.equal(b.hp,defender.hpAvg);assert.equal(a.hp,rng()===0?1000:990);}
 assert.equal(actionEv(missile,source,defender),0);
 const a=e.initState(source),b=e.initState(defender);e.resolveAction(source,defender,a,b,{...hit('force'),ranged:true,melee:false},fixed,0,30,log());assert.equal(b.hp,defender.hpAvg-10);
});
test('Burn and Magmin Touch ignite one nonstacking 1d4 Burning hazard',()=>{
 for(const [name,attack] of [['Fire Elemental','Burn'],['Magmin','Touch']]) {
  const x=setup(name);use(x,attack);use(x,attack);assert.equal(x.b.conditions.filter(c=>c.name==='burning').length,1);
  const hp=x.b.hp;e.resolveConditionDamage([x.owner,x.foe],[x.a,x.b],1,'start',fixed,x.l);assert.equal(x.b.hp,hp-2);
 }
});
test('Fire Aura ignites at source end and the victim burns at its next turn start',()=>{
 const x=setup('Fire Elemental');e.endTurn([x.owner,x.foe],[x.a,x.b],0,x.g,fixed,x.l);assert.ok(x.b.conditions.some(c=>c.name==='burning'));
 const hp=x.b.hp;e.resolveConditionDamage([x.owner,x.foe],[x.a,x.b],1,'start',fixed,x.l);assert.equal(x.b.hp,hp-2);
});
test('a creature can spend its action falling Prone and extinguishing Burning',()=>{
 const x=setup('Fire Elemental');use(x,'Burn');
 // Against a foe that cannot light it again; the re-ignition cases are in srd-burning-and-regurgitation.test.ts.
 const spent={...x.owner,sourceTurnAura:undefined,options:[]};
 assert.equal(e.extinguishIfWorthwhile(x.foe,spent,x.b,x.a,1,5,e.createPairEvaluator(x.foe,spent,true),x.l),true);
 assert.ok(!x.b.conditions.some(c=>c.name==='burning'));assert.ok(x.b.conditions.some(c=>c.name==='prone'));assert.equal(x.b.actionSlotUsed,true);
});
test('Flesh Golem Fire Aversion imposes attack/check disadvantage through its next turn, not saves',()=>{
 const source=tank(),defender=block('Flesh Golem'),a=e.initState(source),b=e.initState(defender);
 e.resolveAction(source,defender,a,b,hit('fire'),fixed,0,5,log());assert.ok(b.conditions.some(c=>c.name==='fireAversion'));
 assert.equal(rolls.checkOdds(b,'str',0,11),.25);
 let count=0;e.rollSave(defender,b,'con',100,false,()=>{count++;return .4;});assert.equal(count,1);
 const hp=a.hp;e.resolveAction(defender,source,b,a,hit(),fixed,1,5,log());assert.equal(a.hp,hp-10);
 e.startTurn(defender,b,fixed,log());assert.ok(b.conditions.some(c=>c.name==='fireAversion'));
 e.endTurn([source,defender],[a,b],1,at(5),fixed,log());assert.ok(!b.conditions.some(c=>c.name==='fireAversion'));
});
test('non-Fire damage does not renew a prior Fire Aversion',()=>{
 const source=tank(),defender=block('Flesh Golem'),a=e.initState(source),b=e.initState(defender);
 e.resolveAction(source,defender,a,b,hit('fire'),fixed,0,5,log());e.startTurn(defender,b,fixed,log());
 e.resolveAction(source,defender,a,b,hit(),fixed,0,5,log());e.endTurn([source,defender],[a,b],1,at(5),fixed,log());assert.ok(!b.conditions.some(c=>c.name==='fireAversion'));
});
test('Power Word Stun has no initial save, repeats Con at turn end, ends concentration and respects stun immunity',()=>{
 const x=setup('Glabrezu',tank({hpAvg:150}));x.b.concentrating=true;use(x,'Power Word Stun',()=>.99);
 assert.ok(x.b.conditions.some(c=>c.name==='stunned'));assert.equal(x.b.concentrating,false);
 e.endTurn([x.owner,x.foe],[x.a,x.b],1,x.g,()=>.99,x.l);assert.ok(!x.b.conditions.some(c=>c.name==='stunned'));
 const immune=setup('Glabrezu',tank({hpAvg:150,conditionImmune:['stunned']}));use(immune,'Power Word Stun');assert.equal(immune.b.conditions.length,0);
});
test('Power Word Stun above 150 HP fixes Speed at zero until caster next turn',()=>{
 const x=setup('Glabrezu');use(x,'Power Word Stun');assert.equal(e.currentSpeed(x.foe,x.b),0);assert.ok(!x.b.conditions.some(c=>c.name==='stunned'));
 e.takeTurn([x.owner,x.foe],[x.a,x.b],0,fixed,at(600),x.l,x.ev,false);assert.equal(e.currentSpeed(x.foe,x.b),x.foe.speed);
});
test('Stone Golem Slow saves on Wisdom, halves Speed, lowers AC/Dex saves, blocks reactions and limits Attack action',()=>{
 const x=setup('Stone Golem', {...tank(),options:block('Guard').options,routines:[{name:'three',parts:[{optionIdx:0,count:3}]}]});
 use(x,'Slow',()=>0);assert.equal(e.currentSpeed(x.foe,x.b),15);assert.equal(e.reactionAvailable(x.foe,x.b),false);
 const c=x.b.conditions.find(c=>c.name==='slowed')!;assert.equal(c.acAdjustment,-2);assert.equal(c.oneAttack,true);
 const hp=x.a.hp;e.takeTurn([x.owner,x.foe],[x.a,x.b],1,fixed,x.g,x.l,x.ev,false);
 assert.equal(x.l.lines.filter(s=>s==='Guard uses Spear').length,1);assert.ok(x.a.hp<=hp);
 assert.equal(option(x.owner,'Slow').timing,'bonus');const slow=option(x.owner,'Slow').action;assert.equal(slow.kind==='save'&&slow.ability,'wis');
});
test('Slow expires on a successful repeat save, or concentration failure',()=>{
 const x=setup('Stone Golem');use(x,'Slow',()=>0);e.endTurn([x.owner,x.foe],[x.a,x.b],1,x.g,()=>.99,x.l);assert.equal(e.currentSpeed(x.foe,x.b),30);
 const y=setup('Stone Golem');use(y,'Slow',()=>0);e.dealDamage(y.foe,y.owner,y.b,y.a,hit(),()=>0,1,false,y.l);assert.ok(!y.b.conditions.some(c=>c.name==='slowed'));
});
test('Slow grants somatic spells a 25% failure chance; componentless and Verbal-only spells survive',()=>{
 const owner=tank(),foe=tank(),a=e.initState(owner),b=e.initState(foe);a.conditions.push({name:'slowed',duration:'permanent',source:1,appliedTurn:0,slowCasting:true});
 const s:CombatAction={kind:'autohit',magical:true,spell:true,somatic:true,damage:[{dice:{n:0,d:1,mod:10},type:'force'}]};
 e.resolveAction(owner,foe,a,b,s,()=>0,0,5,log());assert.equal(b.hp,1000);
 e.resolveAction(owner,foe,a,b,{...s,somatic:false},()=>0,0,5,log());assert.equal(b.hp,990);
});
for(const [name,initial] of [['Adult Black Dragon',10],['Ancient Black Dragon',12]] as const) test(`${name} Vitriolic Sphere delays exactly 5d4, excludes successful saves and survives caster death`,()=>{
 const x=setup(name);use(x,'Vitriolic Sphere');assert.equal(x.b.hp,1000-initial*2);
 const hp=x.b.hp;e.endTurn([x.owner,x.foe],[x.a,x.b],1,x.g,fixed,x.l);assert.equal(x.b.hp,hp);
 x.a.hp=0;e.startTurn(x.foe,x.b,fixed,x.l);e.endTurn([x.owner,x.foe],[x.a,x.b],1,x.g,fixed,x.l);assert.equal(x.b.hp,hp-10);assert.equal(x.b.conditions.length,0);
 e.startTurn(x.foe,x.b,fixed,x.l);e.endTurn([x.owner,x.foe],[x.a,x.b],1,x.g,fixed,x.l);assert.equal(x.b.hp,hp-10);
 const y=setup(name);use(y,'Vitriolic Sphere',()=>.99);assert.equal(y.b.conditions.length,0);assert.equal(y.b.hp,1000-initial*2);
});
function castFixture() {const counter=block('Mage'),caster={...tank(),abilityMods:{...tank().abilityMods,con:-100}},s:CombatAction={kind:'save',ability:'dex',dc:100,magical:true,spell:true,spellName:'Test',components:true,range:150,onSuccess:'none',riders:[],damage:[{dice:{n:0,d:1,mod:10},type:'force'}]};return {counter,caster,s,a:e.initState(caster),b:e.initState(counter)};}
test('Counterspell forces caster Con save, spends reaction and the shared Protective Magic use',()=>{
 const x=castFixture();x.a.lastActionHit=true;e.resolveAction(x.caster,x.counter,x.a,x.b,x.s,fixed,0,30,log());assert.equal(x.a.lastActionHit,false);assert.equal(x.b.hp,x.counter.hpAvg);assert.equal(x.b.reactionUsed,true);
 const uses=x.counter.counterspell!.option.uses;assert.equal(uses.t==='perDay'&&x.b.perDay.get(uses.pool!),2);
 e.resolveAction(x.caster,x.counter,x.a,x.b,x.s,fixed,0,30,log());assert.equal(x.b.hp,x.counter.hpAvg-10);
});
test('Counterspell respects range, sight, components, exhaustion of uses and no-reactions',()=>{
 for(const mode of ['range','blind','components','used','slow','empty']){const x=castFixture();if(mode==='blind')x.b.conditions.push({name:'blinded',source:0,duration:'permanent',appliedTurn:0});if(mode==='used')x.b.reactionUsed=true;if(mode==='slow')x.b.conditions.push({name:'slowed',noReactions:true,source:0,duration:'permanent',appliedTurn:0});if(mode==='empty'){const u=x.counter.counterspell!.option.uses;if(u.t==='perDay')x.b.perDay.set(u.pool!,0);}
 e.resolveAction(x.caster,x.counter,x.a,x.b,{...x.s,components:mode!=='components'},fixed,0,mode==='range'?65:30,log());assert.equal(x.b.hp,x.counter.hpAvg-10,mode);}
});
test('Counterspell preserves a slot on failed caster save while consuming its action',()=>{
 const x=castFixture(),o={name:'Test',sourceText:'',sourceRef:'test',action:x.s,timing:'action' as const,uses:{t:'perDay' as const,max:1,pool:'spell-slots:3'}};
 x.caster.options=[o];x.a=e.initState(x.caster);e.spend(x.a,0,o);e.resolveAction(x.caster,x.counter,x.a,x.b,o.action,fixed,0,30,log());
 assert.equal(x.a.perDay.get('spell-slots:3'),1);assert.equal(x.a.spellSlotSpent,false);assert.equal(x.a.actionSlotUsed,true);
});
test('Counterspell can be countered, with each caster paying its own reaction',()=>{
 const caster={...block('Mage'),abilityMods:{...block('Mage').abilityMods,con:-100}},foe={...block('Mage'),abilityMods:{...block('Mage').abilityMods,con:-100}},a=e.initState(caster),b=e.initState(foe),l=log();
 const spell=option(caster,'Fireball').action;e.resolveAction(caster,foe,a,b,spell,fixed,0,30,l);assert.equal(a.reactionUsed,true);assert.equal(b.reactionUsed,true);assert.ok(b.hp<foe.hpAvg);assert.equal(l.lines.filter(s=>s==='Mage casts Counterspell').length,2);
});
test('countered componentless monster Slow is not eligible and caster save success preserves the spell',()=>{
 const x=castFixture();x.caster.abilityMods.con=100;e.resolveAction(x.caster,x.counter,x.a,x.b,x.s,fixed,0,30,log());assert.equal(x.b.hp,x.counter.hpAvg-10);
 assert.equal(option(block('Stone Golem'),'Slow').action.components,false);assert.equal(option(block('Lich'),'Power Word Kill').action.components,true);
});
for(const [name,attack] of [['Gnoll Warrior','Rend'],['Giant Hyena','Bite']]) test(`${name} Rampage triggers immediately on damage to an already Bloodied victim, once per day`,()=>{
 const x=setup(name);x.g.maxDistance=5;x.b.hp=500;e.takeTurn([x.owner,x.foe],[x.a,x.b],0,fixed,x.g,x.l,x.ev,false);
 assert.equal(x.l.lines.filter(s=>s===`${name} uses bonus action Rampage (1/Day)`).length,1);
 const idx=x.owner.options.findIndex(o=>o.requiresBloodiedDamage);assert.equal(x.a.perDay.get(idx),0);
 e.takeTurn([x.owner,x.foe],[x.a,x.b],0,fixed,x.g,x.l,x.ev,false);assert.equal(x.l.lines.filter(s=>s===`${name} uses bonus action Rampage (1/Day)`).length,1);
 const y=setup(name);y.b.hp=501;const hitAction={...option(y.owner,attack).action,damage:[{dice:{n:0,d:1,mod:10},type:'piercing'}]};e.resolveAction(y.owner,y.foe,y.a,y.b,hitAction,fixed,0,5,y.l);assert.equal(y.a.bloodiedDamage,false);
});
test('Pursuit answers movement within 120 feet, pays reaction and reaches within ten feet',()=>{
 const x=setup('Nalfeshnee');x.g=at(40);e.applyMovement(x.foe,x.b,x.owner,x.a,1,x.g,60,0,fixed,x.l,x.ev,'moves',false,30);
 assert.ok(x.g.distance<=10);assert.equal(x.a.reactionUsed,true);assert.match(x.l.lines.join('\n'),/uses Pursuit/);
});
test('Pursuit requires sight, range and an available reaction',()=>{
 for(const mode of ['used','blind','far']){const x=setup('Nalfeshnee');x.g=at(mode==='far'?120:40);if(mode==='used')x.a.reactionUsed=true;if(mode==='blind')x.a.conditions.push({name:'blinded',duration:'permanent',source:1,appliedTurn:0});e.applyMovement(x.foe,x.b,x.owner,x.a,1,x.g,mode==='far'?130:60,0,fixed,x.l,x.ev,'moves',false,30);assert.ok(!x.l.lines.some(s=>s.includes('uses Pursuit')),mode);}
});
test('Ettercap Reel pulls only its own restrained target within 30 feet, no opportunity attack',()=>{
 const x=setup('Ettercap');x.g=at(30);use(x,'Reel');assert.equal(x.g.distance,30);
 x.b.conditions.push({name:'restrained',duration:'untilEscape',source:1,appliedTurn:0});use(x,'Reel');assert.equal(x.g.distance,30);
 x.b.conditions[0].source=0;use(x,'Reel');assert.equal(x.g.distance,5);assert.equal(x.b.reactionUsed,false);
 x.g=at(35);use(x,'Reel');assert.equal(x.g.distance,35);
});
test('Troll and Xorn Charge add half/full current Speed without spending normal movement',()=>{
 for(const [name,amount] of [['Troll',15],['Xorn',20]] as const){const x=setup(name);x.g=at(80);use(x,'Charge');assert.equal(x.g.distance,80-amount);assert.equal(x.a.movementPenalty,0);}
 const x=setup('Troll');x.g=at(80);x.a.conditions.push({name:'stunned',duration:'permanent',source:1,appliedTurn:0});use(x,'Charge');assert.equal(x.g.distance,80);
});
test('all listed Leap owners compile; Leap spends ten movement and cannot be used at zero Speed',()=>{
 for(const name of ['Giant Ape','Bulette','Hezrou','Lamia','Half-Dragon'])assert.equal(option(block(name),'Leap').timing,'bonus');
 const x=setup('Giant Ape');x.g=at(80);use(x,'Leap');assert.equal(x.a.movementPenalty,10);assert.ok(Math.abs(x.g.distance-80)<=30);
 const y=setup('Giant Ape');y.g=at(80);y.a.conditions.push({name:'grappled',duration:'untilEscape',source:1,appliedTurn:0});use(y,'Leap');assert.equal(y.g.distance,80);assert.equal(y.a.movementPenalty,0);
});
test('Deathless Agility chooses Dash or Disengage, not both; Disengage protects the rest of its turn',()=>{
 for(const name of ['Vampire Spawn','Vampire Familiar']){const x=setup(name);assert.ok(option(x.owner,'Deathless Agility (Dash)'));use(x,'Deathless Agility (Disengage)');assert.equal(x.g.distance,5);assert.equal(e.movementProvokeGuard(x.owner,x.a,x.foe,x.b,5),false);const dash=option(x.owner,'Deathless Agility (Dash)').action;assert.equal(dash.kind==='selfbuff'&&dash.movement?.noProvoke,false);}
});
test('Sphinx exhaustion stacks to six, slows by five feet and penalizes all d20 tests by two per level',()=>{
 const x=setup('Sphinx of Lore');for(let i=0;i<5;i++)use(x,'Weight of Years',()=>0);
 assert.equal(x.b.conditions.filter(c=>c.name==='exhaustion').length,5);assert.equal(e.currentSpeed(x.foe,x.b),5);assert.equal(rolls.checkOdds(x.b,'wis',0,11),0);
 assert.equal(e.rollSave(x.foe,x.b,'con',15,false,()=>.99),false);use(x,'Weight of Years',()=>0);assert.equal(x.b.slain,true);assert.equal(x.b.hp,0);
});
test('Weight of Years respects exhaustion immunity and cannot repeat until source next turn',()=>{
 const x=setup('Sphinx of Valor',tank({conditionImmune:['exhaustion']}));use(x,'Weight of Years',()=>0);assert.equal(x.b.conditions.length,0);
 const idx=x.owner.options.findIndex(o=>o.name==='Weight of Years');e.spend(x.a,idx,x.owner.options[idx]);assert.equal(e.usable(x.a,idx,x.owner.options[idx]),false);e.startTurn(x.owner,x.a,fixed,x.l);assert.equal(e.usable(x.a,idx,x.owner.options[idx]),true);
});
test('Unicorn shield grants nonstacking temp HP and +2 AC through its next turn',()=>{
 const x=setup('Unicorn');use(x,'Shimmering Shield');assert.equal(x.a.tempHp,9);assert.equal(x.a.conditions[0].acAdjustment,2);
 e.resolveAction(x.foe,x.owner,x.b,x.a,{...hit(),toHit:3},fixed,1,5,x.l);assert.equal(x.a.tempHp,9);assert.equal(x.a.hp,x.owner.hpAvg);
 e.startTurn(x.owner,x.a,fixed,x.l);e.endTurn([x.owner,x.foe],[x.a,x.b],0,x.g,fixed,x.l);assert.ok(!x.a.conditions.some(c=>c.name==='shimmeringShield'));assert.equal(x.a.tempHp,9);
});
test('Bronze Repulsion Breath pushes 60 feet only on failed save, including already Prone targets',()=>{
 for(const name of ['Adult Bronze Dragon','Ancient Bronze Dragon']){const x=setup(name);x.g=at(20);use(x,'Repulsion Breath',()=>0);assert.equal(x.g.distance,80);assert.ok(x.b.conditions.some(c=>c.name==='prone'));assert.equal(x.b.reactionUsed,false);x.g=at(20);use(x,'Repulsion Breath',()=>0);assert.equal(x.g.distance,80);
 const y=setup(name,tank({abilityMods:{...tank().abilityMods,str:100}}));y.g=at(20);use(y,'Repulsion Breath',()=>.99);assert.equal(y.g.distance,20);}
});
test('Gibbering failed-save branches deny a normal turn or make exactly one melee attack; successful saves preserve turns',()=>{
 const owner=block('Gibbering Mouther'),foe={...tank(),abilityMods:{...tank().abilityMods,wis:-100},options:block('Guard').options,routines:[{name:'three',parts:[{optionIdx:0,count:3}]}]};
 for(const result of [1,5,7]){const a=e.initState(owner),b=e.initState(foe),l=log(),g=at(5);let calls=0;const rng=()=>++calls===2?(result-.5)/8:0;e.takeTurn([owner,foe],[a,b],1,rng,g,l,e.createPairEvaluator(owner,foe,true),false);assert.ok(l.lines.some(s=>s===`Guard rolls Gibbering ${result}`));assert.ok(!l.lines.some(s=>s==='Guard uses Spear'));assert.equal(b.conditions.length,0);}
 const pass={...foe,abilityMods:{...foe.abilityMods,wis:100}},a=e.initState(owner),b=e.initState(pass),l=log();e.takeTurn([owner,pass],[a,b],1,fixed,at(5),l,e.createPairEvaluator(owner,pass,true),false);assert.equal(l.lines.filter(s=>s==='Guard uses Spear').length,3);
});
test('Agile and elemental absorption remain supported',()=>{
 for(const name of ['Deer','Rat']){const x=setup(name);assert.equal(e.movementProvokeGuard(x.owner,x.a,x.foe,x.b,5),false);}
 const x=setup('Clay Golem');x.a.hp-=20;e.resolveAction(x.foe,x.owner,x.b,x.a,hit('acid'),fixed,1,5,x.l);assert.equal(x.a.hp,x.owner.hpAvg-10);
});
