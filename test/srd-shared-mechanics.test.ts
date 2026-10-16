import assert from 'node:assert/strict';
import test from 'node:test';
import { compileAllDetailed, compileMonster } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as engine } from '../src/engine/fight.ts';
import type { CombatAction, CombatStatblock } from '../src/types.ts';
const { blocks } = compileAllDetailed();
const block = (name: string) => blocks.find(b => b.name === name)!;
const fixed = () => 0.4; // d20=9, d10=5, d8=4, d6=3
const log = () => new FightLog(true);
const packet = (amount: number, type = 'piercing', melee = false): CombatAction => ({kind:'attack', toHit:100, melee, ranged:!melee, range:120, reach:5, magical:false, damage:[{dice:{n:0,d:1,mod:amount},type}],riders:[]});
const tail = block('Horned Devil').options.find(o => o.name === 'Infernal Tail')!.action;
const wound = ('riders' in tail ? tail.riders : [])!.find(r => r.condition === 'wound')!;
function wounded(name = 'Guard') {
  const source = block('Horned Devil'), target = block(name), a = engine.initState(source), b = engine.initState(target);
  engine.applyRiders(b, target, a, [wound], 0, false, () => 0, log(), true);
  return {source,target,a,b};
}

test('Horned Devil wound has printed expiry, Medicine DC and spell exit; repeated tail does not reset it', () => {
  assert.equal(wound.rounds,10); assert.equal(wound.stanchDc,17); assert.equal(wound.endsOnHealingSpell,true);
  const {source,target,a,b} = wounded();
  a.turnCount = 5;
  engine.applyRiders(b,target,a,[wound],0,false,()=>0,log(),true);
  assert.equal(b.conditions.filter(c=>c.name==='wound').length,1);
  assert.equal(b.conditions[0].endsSourceTurn,10);
  a.turnCount = 9; engine.expireClockedConditions(source,target,a,b,0,log()); assert.equal(b.conditions.length,1);
  a.turnCount = 10; engine.expireClockedConditions(source,target,a,b,0,log()); assert.equal(b.conditions.length,0);
});

test('only a spell that restores real HP closes a wound; blocked healing, temp HP and ordinary healing do not', () => {
  const {source,target,a,b} = wounded('Priest');
  const heal = target.options.find(o=>o.name==='Healing Word')!.action;
  b.hp = b.maxHp;
  engine.resolveAction(target,source,b,a,heal,fixed,1,5,log()); assert.ok(b.conditions.some(c=>c.name==='wound'));
  b.hp -= 10;
  engine.resolveAction(target,source,b,a,{kind:'selfheal',healing:{n:0,d:1,mod:1}},fixed,1,5,log()); assert.ok(b.conditions.some(c=>c.name==='wound'));
  engine.resolveAction(target,source,b,a,{kind:'selfheal',healing:{n:0,d:1,mod:0},selfTempHp:{dice:{n:0,d:1,mod:5}}},fixed,1,5,log()); assert.ok(b.conditions.some(c=>c.name==='wound'));
  const curse = {name:'curse',duration:'permanent' as const,source:0 as const,appliedTurn:0,blocksHealing:true as const};
  b.conditions.push(curse);
  engine.resolveAction(target,source,b,a,heal,fixed,1,5,log()); assert.ok(b.conditions.some(c=>c.name==='wound'));
  b.conditions = b.conditions.filter(c=>c!==curse);
  engine.resolveAction(target,source,b,a,heal,fixed,1,5,log()); assert.ok(!b.conditions.some(c=>c.name==='wound'));
});

test('wound ticks lose HP directly, leaving temporary HP and concentration intact', () => {
  const {source,target,a,b} = wounded('Mage'); b.tempHp=100; b.concentrating=true;
  const before=b.hp;
  engine.resolveConditionDamage([source,target],[a,b],1,'start',fixed,log());
  assert.equal(b.hp,before-9); assert.equal(b.tempHp,100); assert.equal(b.concentrating,true);
});

test('Medicine attempts consume an action on success or failure, use Wisdom/skill and respect check disadvantage', () => {
  const {source,target,a,b} = wounded();
  const weak = {...target, options:[], routines:[], abilityMods:{...target.abilityMods,wis:0},skills:{...target.skills,medicine:5}};
  const evaluator=engine.createPairEvaluator(weak,source,true);
  const l=log();
  assert.equal(engine.stanchIfWorthwhile(weak,source,b,a,1,5,evaluator,()=>0.6,l),true); // 13+5
  assert.ok(!b.conditions.some(c=>c.name==='wound'));
  engine.applyRiders(b,weak,a,[wound],0,false,()=>0,log(),true);
  b.conditions.push({name:'poisoned',duration:'permanent',source:0,appliedTurn:0});
  const rolls=[0.99,0];
  assert.equal(engine.stanchIfWorthwhile(weak,source,b,a,1,5,evaluator,()=>rolls.shift()??0,l),true);
  assert.ok(b.conditions.some(c=>c.name==='wound')); assert.match(l.lines.join('\n'),/failure/);
});

test('Medicine is declined near expiry, against a valuable attack, or when bonus healing can close the wound',()=>{
  const {source,target,a,b}=wounded('Priest'); b.hp-=5;
  assert.equal(engine.stanchIfWorthwhile(target,source,b,a,1,5,engine.createPairEvaluator(target,source,true),fixed,log()),false);
  const strong=block('Storm Giant'), c=engine.initState(strong);
  engine.applyRiders(c,strong,a,[wound],0,false,()=>0,log(),true);
  assert.equal(engine.stanchIfWorthwhile(strong,source,c,a,1,5,engine.createPairEvaluator(strong,source,true),fixed,log()),false);
  const weak={...target,options:[],routines:[]};a.turnCount=10;
  assert.equal(engine.stanchIfWorthwhile(weak,source,b,a,1,5,engine.createPairEvaluator(weak,source,true),fixed,log()),false);
});

function hydra() { const h=block('Hydra'), foe=block('Guard'), state=engine.initState(h), other=engine.initState(foe); return {h,foe,state,other}; }
function hitHead(h: CombatStatblock, state: ReturnType<typeof engine.initState>, amount:number,type='piercing') {
  engine.applyDamage(state,h,packet(amount,type),fixed,false,log());
}
function endHead(x: ReturnType<typeof hydra>) {engine.endTurn([x.h,x.foe],[x.state,x.other],0,engine.startingEngagement('max30'),fixed,log());}

test('Hydra aggregates damage within a turn, loses at most one head per turn and grows two per lost head',()=>{
  const x=hydra(); assert.equal(x.state.heads,5); assert.ok(x.h.routines.some(r=>r.parts.some(p=>p.perHead)));
  hitHead(x.h,x.state,12); assert.equal(x.state.heads,5);
  hitHead(x.h,x.state,13); assert.equal(x.state.heads,4);
  hitHead(x.h,x.state,25); assert.equal(x.state.heads,4);
  x.state.headTurnDamage=0;x.state.headLostThisTurn=false;
  hitHead(x.h,x.state,25); assert.equal(x.state.heads,3);
  const hp=x.state.hp;endHead(x); assert.equal(x.state.heads,7); assert.equal(x.state.hp,hp+20); assert.equal(x.state.headsLost,0);
  endHead(x);assert.equal(x.state.heads,7);assert.equal(x.state.hp,hp+20);
});

test('Fire suppresses only the current Hydra regrowth window; dead or heal-blocked Hydras cannot regain HP',()=>{
  const x=hydra();hitHead(x.h,x.state,25);hitHead(x.h,x.state,1,'fire');const hp=x.state.hp;endHead(x);
  assert.equal(x.state.heads,4);assert.equal(x.state.hp,hp);
  x.state.headTurnDamage=0;x.state.headLostThisTurn=false;hitHead(x.h,x.state,25);
  x.state.conditions.push({name:'curse',duration:'permanent',source:1,appliedTurn:0,blocksHealing:true});
  const hp2=x.state.hp;endHead(x);assert.equal(x.state.heads,5);assert.equal(x.state.hp,hp2);
  x.state.heads=1;x.state.headTurnDamage=0;x.state.headLostThisTurn=false;hitHead(x.h,x.state,25);
  assert.equal(x.state.heads,0);assert.equal(x.state.slain,true);assert.equal(x.state.hp,0);endHead(x);assert.equal(x.state.heads,0);
});

test('Hydra attack execution and selection use live head count, with single Bite unchanged',()=>{
  for (const heads of [3,7]) {
    const x=hydra(); x.state.heads=heads;
    const foe={...x.foe,hpAvg:10000,ac:0,options:[],routines:[],retaliation:undefined}; const state=engine.initState(foe);
    const evaluator=engine.createPairEvaluator(x.h,foe,true);
    const low=engine.bestUsableRoutinesAtDistance(x.h,foe,x.state,state,0,5,evaluator).any.ev;
    x.state.heads=5;
    const base=engine.bestUsableRoutinesAtDistance(x.h,foe,x.state,state,0,5,evaluator).any.ev;
    assert.ok(Math.abs(low/base-heads/5)<1e-10);
    x.state.heads=heads;
    const usable=engine.usableRoutineEvAtDistance(x.h,foe,x.state,5,evaluator);
    x.state.heads=5;
    const usableBase=engine.usableRoutineEvAtDistance(x.h,foe,x.state,5,evaluator);
    assert.ok(Math.abs(usable/usableBase-heads/5)<1e-10);
    x.state.heads=heads; const l=log(); const engagement=engine.startingEngagement('max30'); engagement.ground=5; engagement.distance=5;
    engine.takeTurn([x.h,foe],[x.state,state],0,fixed,engagement,l,evaluator,false);
    assert.equal(l.lines.filter(s=>s==='Hydra uses Bite').length,heads);
  }
});

test('Hydra extra reactions are reserved for opportunity attacks and reset at its turn start',()=>{
  const x=hydra(); x.state.reactionUsed=true;
  assert.equal(engine.movementProvokeGuard(x.foe,x.other,x.h,x.state,5),true);
  x.state.extraOpportunityUsed=4;
  assert.equal(engine.movementProvokeGuard(x.foe,x.other,x.h,x.state,5),false);
  engine.startTurn(x.h,x.state,fixed,log()); assert.equal(x.state.extraOpportunityUsed,0);assert.equal(x.state.reactionUsed,false);
  x.state.heads=1;x.state.reactionUsed=true;
  assert.equal(engine.movementProvokeGuard(x.foe,x.other,x.h,x.state,5),false);
  x.state.heads=5;x.state.conditions.push({name:'stunned',duration:'permanent',source:1,appliedTurn:0});
  assert.equal(engine.movementProvokeGuard(x.foe,x.other,x.h,x.state,5),false);
});

function deflect(amount=8,type='piercing',distance=30,melee=false,save=()=>0) {
  const giant=block('Stone Giant'), attacker={...block('Guard'),hpAvg:100}, a=engine.initState(attacker),d=engine.initState(giant),l=log();
  engine.dealDamage(attacker,giant,a,d,packet(amount,type,melee),save,0,false,l,1,undefined,false,distance,{});
  return {giant,attacker,a,d,l};
}

test('Deflect Missile reduces damage, redirects only at zero and spends recharge plus reaction',()=>{
  const x=deflect(8,'piercing',30,false,fixed);
  assert.equal(x.giant.reaction?.kind,'deflectMissile');assert.deepEqual(x.giant.reaction?.uses,{t:'recharge',min:5});
  assert.equal(x.d.hp,x.d.maxHp);assert.equal(x.a.hp,89);assert.equal(x.d.reactionUsed,true);
  assert.equal(x.d.recharge.get('defensive-reaction')!.ready,false);
  const y=deflect(20,'piercing',30,false,fixed);assert.equal(y.d.hp,y.d.maxHp-9);assert.equal(y.a.hp,100);
  engine.startTurn(x.giant,x.d,()=>0.5,log());assert.equal(x.d.recharge.get('defensive-reaction')!.ready,false);
  engine.startTurn(x.giant,x.d,()=>0.7,log());assert.equal(x.d.recharge.get('defensive-reaction')!.ready,true);
});

test('Deflection excludes melee and nonphysical packets; redirect requires range, sight and failed Dexterity save',()=>{
  for(const [type,melee] of [['fire',false],['piercing',true]] as const){const x=deflect(8,type,30,melee,fixed);assert.equal(x.d.hp,x.d.maxHp-8);assert.equal(x.d.reactionUsed,false);}
  const far=deflect(8,'piercing',61,false,fixed);assert.equal(far.d.hp,far.d.maxHp);assert.equal(far.a.hp,100);
  const saved=deflect(8,'piercing',30,false,()=>0.99);assert.equal(saved.a.hp,100);
  const x=deflect(8,'piercing',30,false,fixed);
  engine.dealDamage(x.attacker,x.giant,x.a,x.d,packet(8),fixed,0,false,x.l,1,undefined,false,30,{});
  assert.equal(x.d.hp,x.d.maxHp-8); // already used; no free second deflection
  const d=engine.initState(x.giant),a=engine.initState(x.attacker);d.conditions.push({name:'blinded',duration:'permanent',source:0,appliedTurn:0});
  engine.dealDamage(x.attacker,x.giant,a,d,packet(8),fixed,0,false,log(),1,undefined,false,30,{});
  assert.equal(d.hp,d.maxHp);assert.equal(a.hp,100);
});

test('Deflection zeroes a mixed physical packet, but cannot trigger from an immune physical clause',()=>{
  const x=deflect(0); const d=engine.initState(x.giant),a=engine.initState(x.attacker);
  const attack=packet(2);if(attack.kind!=='attack')throw Error();attack.damage.push({dice:{n:0,d:1,mod:2},type:'fire'});
  engine.dealDamage(x.attacker,x.giant,a,d,attack,fixed,0,false,log(),1,undefined,false,30,{});
  assert.equal(d.hp,d.maxHp);assert.equal(a.hp,89);
  const immune={...x.giant,immune:['piercing']};const s=engine.initState(immune);
  engine.dealDamage(x.attacker,immune,a,s,attack,fixed,0,false,log(),1,undefined,false,30,{});
  assert.equal(s.hp,s.maxHp-2);assert.equal(s.reactionUsed,false);
});

test('unrelated multi-headed prose and incomplete deflection prose remain unclaimed',()=>{
  const raw={name:'Control',source:'Test',size:['M'],type:'humanoid',ac:[12],hp:{average:20},speed:{walk:30},str:10,dex:10,con:10,int:10,wis:10,cha:10,cr:'1',trait:[{name:'Multiple Heads',entries:['It has two heads.']}],reaction:[{name:'Deflect Missile',entries:['It reduces damage.']}],action:[{name:'Strike',entries:['{@atkr m} {@hit 2}, reach 5 ft. {@h}2 ({@damage 1d4}) Slashing damage.']}]};
  const compiled=compileMonster(raw,new Map());assert.equal(compiled.heads,undefined);assert.equal(compiled.reaction,undefined);
});


test('Hydra actually spends each extra opportunity reaction, then its normal reaction, with no sixth attack',()=>{
  const x=hydra(), mover={...x.foe,hpAvg:10000}; const state=engine.initState(mover);
  const engagement=engine.startingEngagement('max30');engagement.ground=5;engagement.distance=5;
  const evaluator=engine.createPairEvaluator(mover,x.h,true),l=log();
  for(let i=0;i<6;i++) {
    engine.applyMovement(mover,state,x.h,x.state,0,engagement,20,0,fixed,l,evaluator,'moves away');
    engine.applyMovement(mover,state,x.h,x.state,0,engagement,5,0,fixed,l,evaluator,'returns');
  }
  assert.equal(l.lines.filter(s=>s==='Hydra makes an opportunity attack').length,5);
  assert.equal(x.state.extraOpportunityUsed,4);assert.equal(x.state.reactionUsed,true);
});

test('Deflection return shot can kill a ranged attacker and stop the remaining multiattack',()=>{
  const giant=block('Stone Giant'), attacker={...block('Guard'),hpAvg:5,options:[{...block('Guard').options[0],name:'Arrow',action:packet(8)}],routines:[{name:'Multiattack',parts:[{optionIdx:0,count:3}]}]};
  const a=engine.initState(attacker), d=engine.initState(giant),l=log(),engagement=engine.startingEngagement('max30');
  engagement.ground=30;engagement.distance=30;
  engine.takeTurn([attacker,giant],[a,d],0,fixed,engagement,l,engine.createPairEvaluator(attacker,giant,true),false);
  assert.equal(a.hp<=0,true);assert.equal(l.lines.filter(s=>s==='Guard uses Arrow').length,1);assert.equal(d.hp,d.maxHp);
});

test('misses and saving-throw damage do not spend Deflect Missile; a thrown attack beyond reach can trigger it',()=>{
  const x=deflect(0), a=engine.initState(x.attacker),d=engine.initState(x.giant);
  const miss=packet(8);if(miss.kind!=='attack')throw Error();miss.toHit=-100;
  engine.resolveAction(x.attacker,x.giant,a,d,miss,fixed,0,30,log());assert.equal(d.reactionUsed,false);
  engine.resolveAction(x.attacker,x.giant,a,d,{kind:'save',ability:'dex',dc:100,damage:[{dice:{n:0,d:1,mod:8},type:'piercing'}],riders:[],magical:false,onSuccess:'none'},fixed,0,30,log());
  assert.equal(d.reactionUsed,false);
  const thrown=packet(8);if(thrown.kind!=='attack')throw Error();thrown.melee=true;thrown.ranged=true;
  engine.dealDamage(x.attacker,x.giant,a,d,thrown,fixed,0,false,log(),1,undefined,false,30,{});assert.equal(d.reactionUsed,true);
});


test('Bearded Devil shares wound exits with its own printed DC and tick value',()=>{
  const action=block('Bearded Devil').options.find(o=>o.name==='Infernal Glaive')!.action;
  const rider=('riders' in action?action.riders:[])!.find(r=>r.condition==='wound')!;
  assert.equal(rider.rounds,10);assert.equal(rider.stanchDc,12);assert.equal(rider.endsOnHealingSpell,true);
  assert.deepEqual(rider.startTurnDamage?.[0].dice,{n:1,d:10,mod:0});
});


test('a chosen Medicine action replaces attacks in the real turn loop',()=>{
  const {source,target,a,b}=wounded();
  const weak={...target,hpAvg:100,speed:0,options:[{...target.options[0],name:'Strike',action:packet(1,'piercing',true)}],routines:[{name:'Strike',parts:[{optionIdx:0,count:1}]}]};
  b.hp=100;b.maxHp=100;
  const engagement=engine.startingEngagement('max30');engagement.ground=5;engagement.distance=5;const l=log();
  engine.takeTurn([source,weak],[a,b],1,()=>0.9,engagement,l,engine.createPairEvaluator(source,weak,true),false);
  assert.ok(l.lines.some(s=>s.includes('attempts to stanch its wound')));
  assert.ok(!l.lines.some(s=>s==='Guard uses Strike'));assert.ok(!b.conditions.some(c=>c.name==='wound'));
});

test('critical hits double incoming attack dice but not the deflection die',()=>{
  const x=deflect(0),a=engine.initState(x.attacker),d=engine.initState(x.giant),attack=packet(8);
  if(attack.kind!=='attack')throw Error();attack.damage[0].dice={n:1,d:10,mod:8};
  engine.dealDamage(x.attacker,x.giant,a,d,attack,fixed,0,true,log(),1,undefined,false,30,{});
  assert.equal(d.hp,d.maxHp-7);assert.equal(a.hp,100);
});
