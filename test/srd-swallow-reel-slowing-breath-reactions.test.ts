// Swallow, Reel, Acid Arrow, Slowing Breath, Half-Dragon origins, Vanish, Unnerving Gaze and reactions such as
// Riposte. Each test is written from the printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { compileAllDetailed, compileMonster } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import { parseAction } from '../src/parse/actions.ts';
import type { AttackAction, CombatStatblock, DraconicOrigin } from '../src/types.ts';
const {blocks}=compileAllDetailed();
const block=(name:string)=>blocks.find(b=>b.name===name)!;
const option=(b:CombatStatblock,name:string)=>b.options.find(o=>o.name===name)!;
const log=()=>new FightLog(true);
const fixed=()=>0.4; // d20=9; d4=2, d6=3, d8=4
const target=(size=2)=>({...block('Guard'),size,ac:0,hpAvg:1000,options:[],routines:[],reaction:undefined,rebuke:undefined});
const hit=(toHit=100): AttackAction=>({kind:'attack',toHit,damage:[{dice:{n:0,d:1,mod:10},type:'piercing'}],riders:[],magical:false,melee:true,ranged:false,reach:5});
const at=(distance:number)=>{const g=e.startingEngagement('max30');g.ground=distance;g.distance=distance;return g;};
function frog() {
 const source=block('Giant Frog'),foe=target(1),a=e.initState(source),b=e.initState(foe);
 a.turnCount=1;
 e.resolveAction(source,foe,a,b,option(source,'Bite').action,fixed,0,5,log());
 const hp=b.hp;
 e.resolveAction(source,foe,a,b,option(source,'Swallow').action,fixed,0,5,log());
 return {source,foe,a,b,hp};
}
test('Frog Swallow consumes own grapple, blinds/restrains, deals no immediate damage and forbids Bite',()=>{
 const x=frog();assert.equal(x.b.hp,x.hp);assert.deepEqual(x.b.conditions.map(c=>c.name),['swallowed','blinded','restrained']);
 const before=x.b.hp;e.resolveAction(x.source,x.foe,x.a,x.b,option(x.source,'Bite').action,fixed,0,5,log());assert.equal(x.b.hp,before);
});
test('Frog has exactly one acid packet at next source end, then disgorges surviving target Prone',()=>{
 const x=frog();const l=log();e.endTurn([x.source,x.foe],[x.a,x.b],0,at(0),fixed,l);assert.equal(x.b.hp,x.hp);
 e.startTurn(x.foe,x.b,fixed,l);e.endTurn([x.source,x.foe],[x.a,x.b],1,at(0),fixed,l);assert.equal(x.b.hp,x.hp);
 e.startTurn(x.source,x.a,fixed,l);e.endTurn([x.source,x.foe],[x.a,x.b],0,at(0),fixed,l);
 assert.equal(x.b.hp,x.hp-4);assert.deepEqual(x.b.conditions.map(c=>c.name),['prone']);assert.match(l.lines.join('\n'),/delayed swallowed/);
 e.startTurn(x.source,x.a,fixed,l);e.endTurn([x.source,x.foe],[x.a,x.b],0,at(5),fixed,l);assert.equal(x.b.hp,x.hp-4);
});
test('Frog excludes larger or ungrappled targets; death releases victim and cancels swallowed packet',()=>{
 const source=block('Giant Frog'),foe=target(),a=e.initState(source),b=e.initState(foe);
 e.resolveAction(source,foe,a,b,option(source,'Bite').action,fixed,0,5,log());e.resolveAction(source,foe,a,b,option(source,'Swallow').action,fixed,0,5,log());assert.ok(!b.conditions.some(c=>c.name==='swallowed'));
 const x=frog();x.a.hp=0;e.endTurn([x.source,x.foe],[x.a,x.b],1,at(0),fixed,log());assert.ok(x.b.conditions.some(c=>c.name==='swallowed'));assert.ok(!x.b.conditions.some(c=>c.name==='restrained'));assert.equal(x.b.conditions.find(c=>c.name==='swallowed')?.delayedDamage,undefined);
 x.a.turnCount=2;e.endTurn([x.source,x.foe],[x.a,x.b],0,at(5),fixed,log());assert.equal(x.b.hp,x.hp);
});
test('Frog acid kill does not disgorge a living survivor',()=>{const x=frog();x.b.hp=3;x.a.turnCount=2;e.endTurn([x.source,x.foe],[x.a,x.b],0,at(0),fixed,log());assert.ok(x.b.hp<=0);assert.ok(!x.b.conditions.some(c=>c.name==='prone'));});
const records=JSON.parse(fs.readFileSync(new URL('../data/bestiary-srd-5.2.1.json',import.meta.url),'utf8')).monster;
const halfRaw=records.find((r:any)=>r.name==='Half-Dragon');
test('Half-Dragon default and all explicit origins consistently bind resistance, Claw and Breath',()=>{
 assert.equal(block('Half-Dragon').draconicOrigin,'acid');
 for(const origin of ['acid','cold','fire','lightning','poison'] as DraconicOrigin[]){
  const b=compileMonster(halfRaw,new Map(),{draconicOrigin:origin});assert.equal(b.draconicOrigin,origin);assert.deepEqual(b.resist,[origin]);
  const claw=option(b,'Claw').action,breath=option(b,"Dragon's Breath").action;assert.ok('damage'in claw&&'damage'in breath);assert.equal(claw.damage[1].type,origin);assert.equal(breath.damage[0].type,origin);assert.equal(claw.damage[1].typeChoices,undefined);
 }
 assert.equal(halfRaw.resist[0].special,'Damage type chosen for the Draconic Origin trait below');
});
test('Reel executes between two Tentacles and two Bites; zero-speed Roper can pull within Bite range',()=>{
 const source={...block('Roper'),speed:0},foe=target(),a=e.initState(source),b=e.initState(foe),g=at(25),l=log();
 const r=source.routines.find(r=>r.name==='Multiattack')!;assert.deepEqual(r.parts.map(p=>source.options[p.optionIdx].name),['Tentacle','Reel','Bite']);
 e.takeTurn([source,foe],[a,b],0,fixed,g,l,e.createPairEvaluator(source,foe,true),false);
 assert.equal(g.distance,5);assert.equal(l.lines.filter(s=>s==='Roper uses Bite').length,2);assert.equal(b.hp,968);assert.equal(a.movedToward,0);assert.equal(b.movedToward,0);
});
test('Reel never pulls an ungrappled or differently sourced target, and is bounded to 30 feet',()=>{
 const source=block('Roper'),foe=target(),a=e.initState(source),b=e.initState(foe),g=at(60),evalr=e.createPairEvaluator(source,foe,true),reel=option(source,'Reel').action;
 e.resolveOptionWithTeleport(source,foe,a,b,reel,fixed,0,g,log(),evalr);assert.equal(g.distance,60);
 b.conditions.push({name:'grappled',duration:'untilEscape',source:1,appliedTurn:0});e.resolveOptionWithTeleport(source,foe,a,b,reel,fixed,0,g,log(),evalr);assert.equal(g.distance,60);
 b.conditions[0].source=0;e.resolveOptionWithTeleport(source,foe,a,b,reel,fixed,0,g,log(),evalr);assert.equal(g.distance,30);assert.equal(b.reactionUsed,false);
});
for(const [name,initial,late] of [['Adult Black Dragon',5,3],['Ancient Black Dragon',6,4]] as const){
 test(`${name} Acid Arrow scales initial and delayed dice independently; miss splashes initial half only`,()=>{
  const source=block(name),foe=target(),a=e.initState(source),b=e.initState(foe),arrow=option(source,'Acid Arrow').action;assert.equal(arrow.kind,'attack');if(arrow.kind!=='attack')return;
  assert.equal(arrow.damage.length,1);assert.equal(arrow.damage[0].dice.n,initial);assert.equal(arrow.riders[0].delayedDamage?.damage[0].dice.n,late);
  e.resolveAction(source,foe,a,b,arrow,fixed,0,30,log());assert.equal(b.hp,1000-initial*2);assert.equal(b.conditions.length,1);
  e.endTurn([source,foe],[a,b],1,at(30),fixed,log());assert.equal(b.hp,1000-initial*2);
  a.hp=0;e.startTurn(foe,b,fixed,log());e.endTurn([source,foe],[a,b],1,at(30),fixed,log());assert.equal(b.hp,1000-initial*2-late*2);assert.equal(b.conditions.length,0);
  const miss=e.initState({...foe,ac:100});e.resolveAction(source,{...foe,ac:100},e.initState(source),miss,arrow,fixed,0,30,log());assert.equal(miss.hp,1000-initial);assert.equal(miss.conditions.length,0);
 });
}
test('two Acid Arrow hits retain independent one-shot packets; delayed packet is not critical damage',()=>{
 const source=block('Adult Black Dragon'),foe=target(),a=e.initState(source),b=e.initState(foe),arrow=option(source,'Acid Arrow').action;
 e.resolveAction(source,foe,a,b,arrow,()=>0.99,0,30,log());e.resolveAction(source,foe,a,b,arrow,fixed,0,30,log());assert.equal(b.conditions.length,2);
 const hp=b.hp;e.startTurn(foe,b,fixed,log());e.endTurn([source,foe],[a,b],1,at(30),fixed,log());assert.equal(b.hp,hp-12);assert.equal(b.conditions.length,0);
});
test('all Copper Slowing Breaths compile printed control; failed save halves Speed and blocks every reaction path',()=>{
 for(const source of blocks.filter(b=>/Copper Dragon/.test(b.name))){const action=option(source,'Slowing Breath').action;assert.equal(action.kind,'save');assert.ok('riders'in action&&action.riders?.some(r=>r.noReactions&&r.actionOrBonus&&r.speedHalved));}
 const source=block('Copper Dragon Wyrmling'),foe=block('Pirate Captain'),a=e.initState(source),b=e.initState(foe),action=option(source,'Slowing Breath').action;
 e.resolveAction(source,foe,a,b,action,()=>0,0,5,log());assert.equal(e.currentSpeed(foe,b),15);assert.equal(e.reactionAvailable(foe,b),false);assert.equal(e.movementProvokeGuard(source,a,foe,b,5),false);
 assert.equal(e.rebukeAvailable(b,{name:'test',trigger:'tookDamage',uses:{t:'atWill'}}),false);
 e.startTurn(foe,b,fixed,log());assert.equal(e.reactionAvailable(foe,b),false);e.endTurn([source,foe],[a,b],1,at(5),fixed,log());assert.equal(e.currentSpeed(foe,b),30);assert.equal(e.reactionAvailable(foe,b),true);
 const saved=e.initState(foe);e.resolveAction(source,foe,a,saved,action,()=>0.99,0,5,log());assert.equal(saved.conditions.length,0);
});
test('Slowing Breath permits an action or a bonus, preserves Multiattack, and expires after target next turn',()=>{
 const source=block('Copper Dragon Wyrmling'),foe=block('Pirate Captain'),a=e.initState(source),b=e.initState(foe),action=option(source,'Slowing Breath').action;
 e.resolveAction(source,foe,a,b,action,()=>0,0,5,log());const act=option(foe,'Rapier'),bonus=option(foe,"Captain's Charm");
 e.spend(b,0,act);assert.equal(e.usable(b,0,act),true);assert.equal(e.usable(b,2,bonus),false);
 e.startTurn(foe,b,fixed,log());e.spend(b,2,bonus);assert.equal(e.usable(b,0,act),false);
 const c=e.initState(foe);e.resolveAction(source,foe,a,c,action,()=>0,0,5,log());const l=log(),tank={...source,hpAvg:10000,ac:0};e.takeTurn([tank,foe],[e.initState(tank),c],1,fixed,at(5),l,e.createPairEvaluator(tank,foe,true),false);
 assert.equal(l.lines.filter(s=>/^Pirate Captain uses (Rapier|Pistol)$/.test(s)).length,3);assert.ok(!l.lines.some(s=>s==="Pirate Captain uses bonus action Captain's Charm"));
});
test('Vanish is a concentrating bonus, applies attack advantage before revealing, and Consume Life reveals too',()=>{
 const source=block("Will-o'-Wisp"),foe=target(),a=e.initState(source),b=e.initState(foe),vanish=option(source,'Vanish');assert.equal(vanish.timing,'bonus');
 e.resolveAction(source,foe,a,b,vanish.action,fixed,0,5,log());assert.equal(a.concentrating,true);assert.ok(a.conditions.some(c=>c.name==='invisible'));
 let calls=0;e.resolveAction(source,foe,a,b,option(source,'Shock').action,()=>{calls++;return .4;},0,5,log());assert.equal(calls,4);assert.equal(a.concentrating,false);assert.equal(a.conditions.length,0);
 e.resolveAction(source,foe,a,b,vanish.action,fixed,0,5,log());const living={...foe,regeneration:{amount:1,deathRule:true,suppressedBy:[]}};const down=e.initState(living);down.hp=0;e.resolveAction(source,living,a,down,option(source,'Consume Life').action,()=>0.99,0,5,log());assert.equal(a.conditions.length,0);
});
test('Vanish is usable in real turn policy and concentration damage can end it',()=>{
 const source=block("Will-o'-Wisp"),foe={...target(),options:block('Guard').options,routines:block('Guard').routines},a=e.initState(source),b=e.initState(foe),l=log();e.takeTurn([source,foe],[a,b],0,fixed,at(5),l,e.createPairEvaluator(source,foe,true),false);assert.ok(l.lines.includes("Will-o'-Wisp uses bonus action Vanish"));
 e.dealDamage(foe,source,b,a,hit(),()=>0,1,false,log());assert.equal(a.conditions.length,0);assert.equal(a.concentrating,false);
});
test('Unnerving Gaze fires on foe turn start, frightens through that turn only and spends reaction',()=>{
 const source=block('Chain Devil'),foe=target(),a=e.initState(source),b=e.initState(foe),l=log();e.takeTurn([source,foe],[a,b],1,()=>0,at(20),l,e.createPairEvaluator(source,foe,true),false);
 assert.ok(l.lines.includes('Chain Devil uses Unnerving Gaze'));assert.ok(l.lines.includes('Guard gains frightened'));assert.equal(a.reactionUsed,true);assert.equal(b.conditions.length,0);
});
test('Gaze requires mutual sight, range and free reaction; success grants this source immunity',()=>{
 const source=block('Chain Devil'),foe=target();
 for(const mode of ['far','sourceBlind','targetBlind','used','slow']){const a=e.initState(source),b=e.initState(foe),l=log();if(mode==='sourceBlind')a.conditions.push({name:'blinded',duration:'permanent',source:1,appliedTurn:0});if(mode==='targetBlind')b.conditions.push({name:'blinded',duration:'permanent',source:0,appliedTurn:0});if(mode==='used')a.reactionUsed=true;if(mode==='slow')a.conditions.push({name:'slowed',noReactions:true,duration:'permanent',source:1,appliedTurn:0});e.takeTurn([source,foe],[a,b],1,fixed,at(mode==='far'?31:20),l,e.createPairEvaluator(source,foe,true),false);assert.ok(!l.lines.includes('Chain Devil uses Unnerving Gaze'),mode);}
 const a=e.initState(source),b=e.initState(foe),l=log();e.takeTurn([source,foe],[a,b],1,()=>0.99,at(20),l,e.createPairEvaluator(source,foe,true),false);a.reactionUsed=false;e.takeTurn([source,foe],[a,b],1,()=>0,at(20),l,e.createPairEvaluator(source,foe,true),false);assert.equal(l.lines.filter(s=>s==='Chain Devil uses Unnerving Gaze').length,1);
});
test('Riposte counters only a melee hit converted to miss, respects Rapier reach and ends killing routines',()=>{
 const pirate=block('Pirate Captain'),foe=target(),a=e.initState(foe),b=e.initState(pirate),l=log();e.resolveAction(foe,pirate,a,b,hit(9),fixed,0,5,l);assert.equal(b.hp,b.maxHp);assert.equal(a.hp,988);assert.equal(b.reactionUsed,true);assert.ok(l.lines.includes('Pirate Captain uses Riposte'));
 for(const [toHit,dist,melee] of [[0,5,true],[100,5,true],[9,10,true],[9,5,false]] as const){const c=e.initState(foe),d=e.initState(pirate);const attack={...hit(toHit),melee,ranged:!melee,reach:dist};e.resolveAction(foe,pirate,c,d,attack,fixed,0,dist,log());assert.equal(c.hp,1000);}
 const c=e.initState({...foe,hpAvg:1}),d=e.initState(pirate);e.resolveAction({...foe,hpAvg:1},pirate,c,d,hit(9),fixed,0,5,log());assert.ok(c.hp<=0);
});
test('Whirlwind triggers even against uncancelled and critical hits, teleports then blinds at destination',()=>{
 const mummy=block('Mummy Lord'),foe=target();
 for(const rng of [fixed,()=>0.99]){const a=e.initState(foe),b=e.initState(mummy),g=at(25),l=log();e.resolveAction(foe,mummy,a,b,{...hit(100),melee:false,ranged:true,range:120},rng,0,25,l);assert.equal(b.hp,b.maxHp-10);assert.equal(b.reactionUsed,true);e.settleAfterAction(foe,mummy,a,b,0,g,rng,l);assert.ok(g.distance<=5);assert.ok(a.conditions.some(c=>c.name==='blinded'));assert.ok(l.lines.includes('Mummy Lord uses Whirlwind of Sand'));b.turnCount=1;e.endTurn([foe,mummy],[a,b],1,g,fixed,l);assert.equal(a.conditions.length,0);}
});
test('Whirlwind does not answer a miss or unavailable reaction, and sight gates blindness/teleport independently',()=>{
 const mummy=block('Mummy Lord'),foe=target();
 for(const mode of ['miss','used','blind','invisible']){const a=e.initState(foe),b=e.initState(mummy),g=at(25),l=log();if(mode==='used')b.reactionUsed=true;if(mode==='blind')b.conditions.push({name:'blinded',duration:'permanent',source:0,appliedTurn:0});if(mode==='invisible')a.conditions.push({name:'invisible',breaksOnAttackOrSpell:false,duration:'permanent',source:0,appliedTurn:0});e.resolveAction(foe,mummy,a,b,{...hit(mode==='miss'?-100:100),melee:false,ranged:true,range:120},fixed,0,25,l);e.settleAfterAction(foe,mummy,a,b,0,g,fixed,l);if(mode!=='invisible'){assert.equal(g.distance,25);assert.ok(!a.conditions.some(c=>c.name==='blinded'));}else assert.ok(a.conditions.some(c=>c.name==='blinded'));}
});
test('Cacophony requires shared space, rolls once, imposes attack/check disadvantage, recharges on 6 and ends at source start',()=>{
 const source=block('Swarm of Ravens'),foe=target(),a=e.initState(source),b=e.initState(foe),cac=option(source,'Cacophony');assert.equal(cac.action.kind,'save');assert.deepEqual(cac.uses,{t:'recharge',min:6});
 e.resolveAction(source,foe,a,b,cac.action,()=>0,0,5,log());assert.equal(b.conditions.length,0);let saves=0;e.resolveAction(source,foe,a,b,cac.action,()=>{saves++;return 0;},0,0,log());assert.equal(saves,1);assert.deepEqual(b.conditions[0].rollEffects?.map(r=>r.roll),['check','attack']);
 let rolls=0;e.resolveAction(foe,source,b,a,hit(100),()=>{rolls++;return .4;},1,0,log());assert.equal(rolls,2);
 e.spend(a,1,cac);e.startTurn(source,a,()=>0.7,log());assert.equal(e.usable(a,1,cac),false);e.startTurn(source,a,()=>0.99,log());assert.equal(e.usable(a,1,cac),true);
 e.takeTurn([source,foe],[a,b],0,fixed,at(0),log(),e.createPairEvaluator(source,foe,true),false);assert.ok(!b.conditions.some(c=>c.name==='deafened'));
});
test('ordinary Deafened prose does not gain Cacophony penalties, and Deafened immunity blocks its rider',()=>{
 assert.equal(parseAction({name:'Noise',entries:['{@actSave wis} {@dc 10}. {@actSaveFail} The target has the {@condition Deafened} condition until the end of its next turn.']},'action','test').option,undefined);
 const source=block('Swarm of Ravens'),foe={...target(),conditionImmune:['deafened']},a=e.initState(source),b=e.initState(foe);e.resolveAction(source,foe,a,b,option(source,'Cacophony').action,()=>0,0,0,log());assert.equal(b.conditions.length,0);
});
test('Reel pull bounds include body-height offsets and do not spend movement or reactions',()=>{
 const source=block('Roper'),foe=block('Giant Eagle'),a=e.initState(source),b=e.initState(foe),g=at(0);b.height=60;g.distance=50;
 b.conditions.push({name:'grappled',duration:'untilEscape',source:0,appliedTurn:0});
 e.resolveOptionWithTeleport(source,foe,a,b,option(source,'Reel').action,fixed,0,g,log(),e.createPairEvaluator(source,foe,true));assert.equal(b.height,30);assert.ok(g.distance>=20);assert.equal(b.movedToward,0);assert.equal(b.reactionUsed,false);
});
test('Copper adults and young retain Slowing Breath as one Multiattack replacement',()=>{
 for(const source of blocks.filter(b=>/Copper Dragon/.test(b.name)&&!b.name.includes('Wyrmling'))){const idx=source.options.findIndex(o=>o.name==='Slowing Breath');assert.ok(source.routines.some(r=>r.parts.some(p=>p.optionIdx===idx)&&r.parts.reduce((sum,p)=>sum+p.count,0)===3));}
});
test('Half-Dragon origin resistance actually halves origin packets and does not resist another element',()=>{
 const source=block('Half-Dragon'),foe=target(),a=e.initState(source),b=e.initState(foe);
 e.dealDamage(foe,source,b,a,{kind:'autohit',magical:false,damage:[{dice:{n:0,d:1,mod:10},type:'acid'}]},fixed,1,false,log());assert.equal(a.hp,a.maxHp-5);
 e.dealDamage(foe,source,b,a,{kind:'autohit',magical:false,damage:[{dice:{n:0,d:1,mod:10},type:'fire'}]},fixed,1,false,log());assert.equal(a.hp,a.maxHp-15);
});
test('a slowed pre-action aiming bonus excludes the attack and Dash that would follow',()=>{
 const source=block('Copper Dragon Wyrmling'),foe={...block('Guard'),options:[option(block('Guard'),'Spear'),{name:'Aim',sourceText:'Synthetic pre-action aiming bonus',sourceRef:'test.Aim',timing:'bonus' as const,uses:{t:'atWill' as const},action:{kind:'selfbuff' as const,condition:'aiming',breaksOnAttackOrSpell:false}}],routines:[{name:'Spear',parts:[{optionIdx:0,count:1}]}]},a=e.initState(source),b=e.initState(foe),l=log();
 e.resolveAction(source,foe,a,b,option(source,'Slowing Breath').action,()=>0,0,5,l);
 const hp=a.hp;e.takeTurn([source,foe],[a,b],1,fixed,at(5),l,e.createPairEvaluator(source,foe,true),false);assert.ok(l.lines.includes('Guard uses bonus action Aim'));assert.equal(a.hp,hp);assert.ok(!l.lines.some(s=>s.startsWith('Guard dashes')));assert.equal(b.actionSlotUsed,false);
});
test('Riposte kill stops the remaining attacks of an actual Multiattack',()=>{
 const pirate=block('Pirate Captain'),attacker={...target(),hpAvg:1,options:[{name:'Strike',sourceText:'Synthetic three-attack routine',sourceRef:'test.Strike',timing:'action' as const,uses:{t:'atWill' as const},action:hit(9)}],routines:[{name:'Multiattack',parts:[{optionIdx:0,count:3}]}]},a=e.initState(attacker),b=e.initState(pirate),l=log();
 e.takeTurn([attacker,pirate],[a,b],0,fixed,at(5),l,e.createPairEvaluator(attacker,pirate,true),false);assert.ok(a.hp<=0);assert.equal(l.lines.filter(s=>s==='Guard uses Strike').length,1);assert.equal(b.hp,b.maxHp);
});
test('an Acid Arrow hit changed to a miss by AC reaction splashes, with no delayed packet',()=>{
 const source=block('Adult Black Dragon'),foe={...target(),ac:17,reaction:{kind:'parry' as const,acBonus:3,meleeOnly:false}},a=e.initState(source),b=e.initState(foe),arrow=option(source,'Acid Arrow').action;assert.equal(arrow.kind,'attack');if(arrow.kind!=='attack')return;
 e.resolveAction(source,foe,a,b,{...arrow,toHit:9},fixed,0,30,log());assert.equal(b.reactionUsed,true);assert.equal(b.hp,b.maxHp-5);assert.equal(b.conditions.length,0);
});
