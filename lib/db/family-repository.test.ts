import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Client } from 'pg';
import { closeDatabase, currentDatabaseClient, withStorageTransaction } from './client';
import { getDocumentRevision, readCompletionLedger, readDocument, writeDocument } from './repository';
import type { CoinsData, CoinTransaction, HabitsData, User, WishlistData } from '../types';

mock.module('server-only',()=>({}));
const { withFamilyScope, withFreshFamilyActor }=await import('../family-scope');
const enabled=process.env.HABITTROVE_TEST_DATABASE==='1' && !!process.env.DATABASE_URL &&
  /^\/habittrove_test_family_repository_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL).pathname);
const user:User={id:'u',username:'Dual member'};
const admin:User={id:'admin',username:'Administrator',isAdmin:true};
const owner:User={id:'owner',username:'Family owner'};
const q=(sql:string,params:unknown[]=[])=>currentDatabaseClient()!.query(sql,params);
const coin=(id:string,amount:number,extra:Partial<CoinTransaction>={}):CoinTransaction=>({id,amount,type:'MANUAL_ADJUSTMENT',timestamp:'2026-01-01T00:00:00Z',description:id,userId:'u',actorId:'u',...extra});
let migration:Client;

describe.skipIf(!enabled)('family repositories (fresh local restricted-role fixture)',()=>{
  beforeAll(async()=>{
    const target=new URL(process.env.DATABASE_MIGRATION_URL!);
    const runtime=new URL(process.env.DATABASE_URL!);
    if(target.hostname!=='127.0.0.1'||target.port!=='15432'||target.pathname!==runtime.pathname||runtime.username!=='habittrove_test_runtime')throw new Error('Unsafe family repository fixture');
    migration=new Client({connectionString:target.href});await migration.connect();
    await withStorageTransaction(async()=>{
      const role=(await q('SELECT current_user AS name,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
      expect(role).toEqual({name:'habittrove_test_runtime',rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false});
      expect((await q("SELECT has_table_privilege(current_user,'habittrove.global_wallet_totals','UPDATE') AS allowed")).rows[0].allowed).toBe(false);
      expect((await q("SELECT has_sequence_privilege(current_user,'habittrove.coin_ledger_family_order','USAGE') AS usage,has_sequence_privilege(current_user,'habittrove.coin_ledger_family_order','UPDATE') AS update")).rows[0]).toEqual({usage:true,update:false});
    });
  });
  beforeEach(async()=>{
    await migration.query('TRUNCATE habittrove.users,habittrove.families,habittrove.habits,habittrove.wishlist_items,habittrove.coin_ledger,habittrove.global_wallet_totals,habittrove.attachments,habittrove.documents CASCADE');
    await migration.query('UPDATE habittrove.family_configuration SET enabled=true');
    await migration.query("INSERT INTO habittrove.users(id,ordinal,username,is_admin,attributes) VALUES('admin',0,'Admin',true,'{\"fields\":{},\"present\":[]}'),('u',1,'Dual',false,'{\"fields\":{},\"present\":[]}'),('other',2,'Coassignee',false,'{\"fields\":{},\"present\":[]}'),('owner',3,'Owner',false,'{\"fields\":{},\"present\":[]}'),('b',4,'B owner',false,'{\"fields\":{},\"present\":[]}')");
    await migration.query("INSERT INTO habittrove.families(id,name) VALUES('A','A'),('B','B')");
    await migration.query("INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES('A','owner','owner'),('B','b','owner'),('A','u','member'),('B','u','member'),('A','other','member')");
    await migration.query("INSERT INTO habittrove.family_document_revisions(family_id,kind) VALUES('A','habits'),('A','wishlist'),('B','habits'),('B','wishlist')");
    await migration.query("INSERT INTO habittrove.documents(kind,metadata) VALUES('coins','{\"fields\":{\"balance\":0},\"present\":[\"transactions\"],\"balance\":0}')");
    for(const family of ['A','B'])await withFamilyScope(admin,async()=>{
      await writeDocument('habits',{habits:[{id:'h'+family,name:family,description:'',frequency:'daily',coinReward:2,userIds:family==='A'?['u','other']:['u'],completions:['2026-01-01T00:00:00Z'],completionRecords:[{id:'c'+family,actorId:'u',rewardedUserIds:['u','other']}]}]});
      await writeDocument('wishlist',{items:[{id:'w'+family,name:family,description:'',coinCost:3,userIds:['u']}]});
      await writeDocument('coins',{balance:999,transactions:[coin('l'+family,family==='A'?4:6)]});
    },family);
  });
  afterAll(async()=>{await closeDatabase();await migration?.end();});

  test('missing scope denies ordinary domain access even for a site administrator',async()=>{
    await expect(readDocument('habits')).rejects.toThrow('context');
    await expect(withFreshFamilyActor(admin,()=>readDocument('wishlist'))).rejects.toThrow('context');
    await expect(withFreshFamilyActor(admin,()=>writeDocument('habits',{habits:[]}))).rejects.toThrow('context');
    expect((await migration.query('SELECT count(*) AS n FROM habittrove.habits')).rows[0].n).toBe('2');
  });
  test('site administrator replacement is explicitly scoped and retains other-family parents and evidence',async()=>{
    await migration.query("INSERT INTO habittrove.attachments(id,habit_id,completion_id,path,mime_type,family_id) VALUES('ea','hA','cA','evidence/a.png','image/png','A'),('eb','hB','cB','evidence/b.png','image/png','B')");
    const otherBefore=(await migration.query("SELECT to_jsonb(h) AS value FROM habittrove.habits h WHERE family_id='B'")).rows;
    await withFamilyScope(admin,async()=>{
      const habits=(await readDocument<HabitsData & {familyId:string}>('habits'))!;
      expect(habits.familyId).toBe('A');expect(habits.habits.map(h=>h.id)).toEqual(['hA']);
      habits.habits[0].name='Changed A';await writeDocument('habits',habits);
      await writeDocument('wishlist',{items:[]});
      expect((await readDocument<WishlistData>('wishlist'))!.items).toEqual([]);
    },'A');
    expect((await migration.query("SELECT to_jsonb(h) AS value FROM habittrove.habits h WHERE family_id='B'")).rows).toEqual(otherBefore);
    expect((await migration.query('SELECT id FROM habittrove.attachments ORDER BY id')).rows.map(r=>r.id)).toEqual(['ea','eb']);
    expect((await migration.query("SELECT id FROM habittrove.wishlist_items WHERE family_id='B'")).rows[0].id).toBe('wB');
    await expect(withFamilyScope(admin,()=>writeDocument('habits',{habits:[{id:'hB',name:'Forged',description:'',frequency:'daily',coinReward:1,completions:[]}]}),'A')).rejects.toThrow();
    expect((await migration.query("SELECT to_jsonb(h) AS value FROM habittrove.habits h WHERE family_id='B'")).rows).toEqual(otherBefore);
  });
  test('family tags and revisions fence stale writes without unrelated-family conflicts',async()=>{
    const a=await withFamilyScope(user,()=>readDocument<HabitsData & {familyId:string}>('habits'),'A');
    const revisionA=await withFamilyScope(user,()=>getDocumentRevision('habits'),'A');
    await withFamilyScope(user,async()=>{
      await expect(writeDocument('habits',a)).rejects.toThrow('different family');
    },'B').catch(()=>undefined);
    await withFamilyScope(user,()=>writeDocument('habits',{habits:[]}),'B');
    await withFamilyScope(user,()=>writeDocument('habits',a,revisionA),'A');
    await expect(withFamilyScope(user,()=>writeDocument('habits',a,revisionA),'A')).rejects.toThrow('Data changed');
    expect(await withFamilyScope(user,()=>getDocumentRevision('habits'),'A')).toBe(revisionA!+1);
  });
  test('partial wallet writes retain omitted rows, origins and stable prepend ordering across families',async()=>{
    const before=(await migration.query('SELECT id,ordinal::text,ctid::text AS tuple,family_id FROM habittrove.coin_ledger ORDER BY id')).rows;
    await Promise.all(['A','B'].map(family=>withFamilyScope(user,()=>writeDocument('coins',{balance:0,transactions:[coin('new'+family,1)]}),family)));
    expect((await migration.query("SELECT id,ordinal::text,ctid::text AS tuple,family_id FROM habittrove.coin_ledger WHERE id IN ('lA','lB') ORDER BY id")).rows).toEqual(before);
    const current=(await migration.query('SELECT id,ordinal::text,family_id FROM habittrove.coin_ledger ORDER BY coin_ledger.ordinal')).rows;
    expect(new Set(current.map(r=>r.ordinal)).size).toBe(4);
    expect(current.slice(0,2).map(r=>r.id).sort()).toEqual(['newA','newB']);
    expect((await migration.query("SELECT balance::text FROM habittrove.global_wallet_totals WHERE user_id='u'")).rows[0].balance).toBe('12');
  });
  test('own foreign-origin note edits preserve fiscal fields and use the global revision fence',async()=>{
    const before=(await migration.query("SELECT family_id,ordinal::text,amount::text FROM habittrove.coin_ledger WHERE id='lB'")).rows[0];
    const revision=await withFreshFamilyActor(user,()=>getDocumentRevision('coins'));
    await withFamilyScope(user,()=>writeDocument('coins',{balance:-999,transactions:[coin('lB',6,{note:'My B note'})]},revision),'A');
    expect((await migration.query("SELECT family_id,ordinal::text,amount::text FROM habittrove.coin_ledger WHERE id='lB'")).rows[0]).toEqual(before);
    await expect(withFamilyScope(user,()=>writeDocument('coins',{balance:0,transactions:[coin('lB',600)]}),'A')).rejects.toThrow('immutable');
    await expect(withFamilyScope(user,()=>writeDocument('coins',{balance:0,transactions:[]},revision),'B')).rejects.toThrow('Data changed');
    await withFreshFamilyActor(user,()=>writeDocument('coins',{balance:0,transactions:[coin('lB',6,{note:'No selected family'})]}));
    expect((await withFreshFamilyActor(user,()=>readDocument<CoinsData>('coins')))!.transactions.find(t=>t.id==='lB')?.note).toBe('No selected family');
    expect((await migration.query("SELECT metadata->>'balance' AS balance FROM habittrove.documents WHERE kind='coins'")).rows[0].balance).toBe('0');
  });
  test('general wallet reads hide other origins from managers and keep site-admin domain reads selected',async()=>{
    await migration.query("INSERT INTO habittrove.family_manager_assignments VALUES('A','owner','u')");
    const managed=await withFamilyScope(owner,()=>readDocument<CoinsData>('coins'),'A');
    expect(managed!.transactions.map(t=>t.id)).toEqual(['lA']);
    const operational=await withFamilyScope(admin,()=>readDocument<CoinsData>('coins'),'A');
    expect(operational!.transactions.map(t=>t.id)).toEqual(['lA']);
    const own=await withFreshFamilyActor(user,()=>readDocument<CoinsData>('coins'));
    expect(own!.transactions.map(t=>t.id).sort()).toEqual(['lA','lB']);
  });
  test('authorized completion reader reveals co-assignee award and undo only within that event',async()=>{
    await withFamilyScope(admin,()=>writeDocument('coins',{balance:0,transactions:[coin('other-award',2,{userId:'other',relatedItemId:'hA',completionId:'cA',type:'HABIT_COMPLETION'}),coin('other-undo',-1,{userId:'other',relatedItemId:'hA',completionId:'cA',type:'HABIT_UNDO'}),coin('other-private',7,{userId:'other'})]}),'A');
    await withFamilyScope(user,async()=>{
      expect((await readDocument<CoinsData>('coins'))!.transactions.some(t=>t.userId==='other')).toBe(false);
      expect((await readCompletionLedger('hA','cA')).map(t=>t.id)).toEqual(['other-award','other-undo']);
      expect((await readDocument<CoinsData>('coins'))!.transactions.some(t=>t.userId==='other')).toBe(false);
      expect((await q("SELECT current_setting('habittrove.ledger_habit',true) AS value")).rows[0].value??'').toBe('');
    },'A');
    await expect(withFamilyScope(owner,()=>readCompletionLedger('hA','cA'),'A')).rejects.toThrow('access denied');
    await expect(withFamilyScope(user,()=>readCompletionLedger('hA','cA'),'B')).rejects.toThrow('access denied');
  });
  test('legacy completion history is limited to the sole beneficiary and original award/undo types',async()=>{
    await withFamilyScope(admin,async()=>{
      await writeDocument('habits',{habits:[{id:'legacy',name:'Legacy',description:'',frequency:'daily',coinReward:1,userIds:['u'],completions:['2020-01-01T00:00:00Z']}]});
      await writeDocument('coins',{balance:0,transactions:[coin('legacy-award',1,{relatedItemId:'legacy',type:'HABIT_COMPLETION'}),coin('legacy-undo',-1,{relatedItemId:'legacy',type:'HABIT_UNDO'}),coin('legacy-private',5,{relatedItemId:'legacy'})]});
    },'A');
    expect((await withFamilyScope(user,()=>readCompletionLedger('legacy',undefined,'u'),'A')).map(t=>t.id)).toEqual(['legacy-award','legacy-undo']);
    await expect(withFamilyScope(owner,()=>readCompletionLedger('legacy',undefined,'u'),'A')).rejects.toThrow();
  });
  test('completion manager authority binds to the stored beneficiary rather than a supplied managed member',async()=>{
    await migration.query("INSERT INTO habittrove.family_manager_assignments VALUES('A','owner','u')");
    await withFamilyScope(admin,async()=>{
      const habits=(await readDocument<HabitsData>('habits'))!;
      habits.habits[0].completions.push('2026-01-02T00:00:00Z','2026-01-03T00:00:00Z');
      habits.habits[0].completionRecords!.push({id:'other-event',actorId:'other'},{id:'explicit-beneficiary',actorId:'u',beneficiaryId:'other'});
      await writeDocument('habits',habits);
      await writeDocument('coins',{balance:0,transactions:[
        coin('managed-award',2,{relatedItemId:'hA',completionId:'cA',type:'HABIT_COMPLETION'}),
        coin('unrelated-award',2,{userId:'other',relatedItemId:'hA',completionId:'other-event',type:'HABIT_COMPLETION'}),
        coin('explicit-award',2,{userId:'other',relatedItemId:'hA',completionId:'explicit-beneficiary',type:'HABIT_COMPLETION'}),
      ]});
    },'A');
    await expect(withFamilyScope(owner,()=>readCompletionLedger('hA','other-event','u'),'A')).rejects.toThrow('beneficiary mismatch');
    await expect(withFamilyScope(owner,()=>readCompletionLedger('hA','other-event'),'A')).rejects.toThrow('access denied');
    await expect(withFamilyScope(owner,()=>readCompletionLedger('hA','explicit-beneficiary','u'),'A')).rejects.toThrow('beneficiary mismatch');
    await expect(withFamilyScope(owner,()=>readCompletionLedger('hA','explicit-beneficiary'),'A')).rejects.toThrow('access denied');
    expect((await withFamilyScope(owner,()=>readCompletionLedger('hA','cA'),'A')).map(t=>t.id)).toEqual(['managed-award']);
    await migration.query("INSERT INTO habittrove.family_manager_assignments VALUES('A','owner','other')");
    await withFamilyScope(owner,async()=>{
      expect((await readCompletionLedger('hA','explicit-beneficiary','other')).map(t=>t.id)).toEqual(['explicit-award']);
      expect((await q("SELECT current_setting('habittrove.ledger_habit',true) AS habit,current_setting('habittrove.ledger_completion',true) AS completion,current_setting('habittrove.ledger_beneficiary',true) AS beneficiary")).rows[0]).toEqual({habit:'',completion:'',beneficiary:''});
    },'A');
  });
  test('disabled families preserve Stage A replacement behavior and document shapes',async()=>{
    await migration.query('UPDATE habittrove.family_configuration SET enabled=false');
    await writeDocument('habits',{habits:[]});
    expect(await readDocument<HabitsData>('habits')).toEqual({habits:[]});
    await writeDocument('coins',{balance:2,transactions:[coin('stage-a',2)]});
    expect(await readDocument<CoinsData>('coins')).toEqual({balance:2,transactions:[coin('stage-a',2)]});
  });
});
