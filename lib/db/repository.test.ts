import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { afterStorageCommit, assertDatabaseTarget, closeDatabase, migrateDatabase, withStorageTransaction, currentDatabaseClient } from './client';
import { exportDatabaseSnapshot, getDocumentRevision, importDatabaseSnapshot, readAttachmentMetadata, upsertAttachmentMetadata, readAuthDocument, readDocument, writeAuthDocument, writeDocument, type DatabaseSnapshot } from './repository';
test('database target guard excludes unrelated databases and requires explicit test opt in', () => {
  expect(() => assertDatabaseTarget('postgresql://localhost/postgres', false)).toThrow();
  expect(() => assertDatabaseTarget('postgresql://localhost/habittrove_test_fixture', false)).toThrow();
  expect(() => assertDatabaseTarget('postgresql://localhost/habittrove_test_fixture', true)).not.toThrow();
});
test('database URL options cannot override role, target, transport verification or resource limits', () => {
  for(const option of ['user=postgres','host=other','port=9999','options=-c%20search_path=public','database=postgres','dbname=postgres',
    'sslmode=no-verify','sslmode=require','sslmode=verify-full&uselibpqcompat=true','statement_timeout=0','lock_timeout=0','sslmode=verify-full&sslmode=no-verify']) {
    expect(()=>assertDatabaseTarget(`postgresql://habittrove_test_runtime@localhost/habittrove?${option}`,false)).toThrow();
  }
  expect(()=>assertDatabaseTarget('postgresql://habittrove_test_runtime@localhost/habittrove?sslmode=verify-full',false)).not.toThrow();
});

test('cleanup outside a storage transaction executes immediately with errors isolated', async()=>{
  let called=0;
  await afterStorageCommit(async()=>{called++;});
  await afterStorageCommit(async()=>{throw new Error('cleanup failure');});
  expect(called).toBe(1);
});

const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!process.env.DATABASE_URL;
const fixture: DatabaseSnapshot = {
  auth: {
    users: [
      { id: 'u', username: 'Member', password: 'unchanged', email: 'member@example.test', isAdmin: true, authVersion: 3,
        authentikSubject: 'subject', oidcIssuer: 'https://identity.example.test/',
        permissions: [{habit:{write:true,interact:false},wishlist:{write:false,interact:true},coins:{write:false,interact:false}}],
        managedUserIds: ['u2'], personalFolders: [{id:'folder',name:'Personal',itemIds:['old-123','deleted-item']}],
        statusDays: [{date:'2024-02-29',status:'rest'}] },
      { id:'u2', username:'Second', oidcIssuer:'legacy-unbound-issuer', permissions:[], managedUserIds:[], personalFolders:[], statusDays:[] }
    ],
    invites: [{tokenHash:'hash',email:'invited@example.test',createdBy:'deleted',managedBy:'u',expiresAt:'2028-01-01T00:00:00Z'}]
  },
  habits: { habits: [
    { id: 'old-123', name: 'Legacy', description: '', frequency: 'daily', coinReward: 0.25, createdBy:'deleted',
      requiresApproval:true, archived:false, userIds: ['u'], approverIds:['u2'], checklist:[{id:'check',text:'Entry',completed:false}],
      completions: ['2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '2024-01-03T00:00:00Z'],
      completionRecords: [null, {id:'c',actorId:'deleted',rewardedUserIds:[],voided:true},
        {id:'c2',actorId:'deleted',approval:'approved',beneficiaryId:'deleted-too',rewardAmount:0.125,reviewedBy:'past-reviewer',reviewedAt:'2024-01-03T01:00:00+00:00',evidenceId:'evidence',evidenceMime:'image/png'}],
      slips:[{id:'slip',actorId:'deleted',timestamp:'2024-01-04T00:00:00Z',penaltyAmount:0.0625}] },
    { id:'missing-records',name:'Older',description:'',frequency:'weekly',coinReward:1,completions:['2023-01-01T00:00:00Z'] },
    { id:'empty-records',name:'Empty',description:'',frequency:'weekly',coinReward:1,completions:[],completionRecords:[],userIds:[],approverIds:[],checklist:[],slips:[] }
  ] },
  wishlist: { items: [{id:'wish',name:'Reward',description:'',coinCost:0.125,userIds:['u']}] },
  coins: { balance: 0.25, transactions: [{ id: 't', amount: 0.25, type: 'HABIT_COMPLETION', description: 'old', timestamp: '2024-01-01T00:00:00Z', userId: 'deleted', relatedItemId: 'deleted-item' }] },
  attachments:[{id:'avatar:person.png',owner_id:'u',path:'avatars/person.png',mime_type:'image/png',sha256:'a'.repeat(64)},
    {id:'evidence',habit_id:'old-123',completion_id:'c2',owner_id:'deleted-too',path:'evidence/evidence.png',mime_type:'image/png',sha256:'b'.repeat(64)}],
  settings: { ui: { useNumberFormatting: true, useGrouping: true }, system: { timezone: 'UTC', weekStartDay: 1, autoBackupEnabled: false, language: 'en' }, profile: {} }, adminConfig: { ciphertext: 'retained' }
};

describe.skipIf(!enabled)('real PostgreSQL relational adapter (dedicated empty test database)', () => {
  beforeAll(async () => {
    if (!/^habittrove_(test|qa)_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL!).pathname.slice(1)))
      throw new Error('Tests require a disposable HabitTrove test database');
    await migrateDatabase();
    await withStorageTransaction(async () => {
      for (const table of ['habits', 'wishlist_items', 'coin_ledger', 'users', 'invitations', 'documents', 'setting_sections', 'admin_configuration', 'migration_batches', 'attachments', 'authentication_throttles', 'job_leases'])
        await currentDatabaseClient()!.query(`DELETE FROM ${table}`);
    });
  });
  afterAll(closeDatabase);
  test('imports exactly; replay verifies; conflicting replay refuses overwrite', async () => {
    expect(await readDocument('habits')).toBeUndefined();
    expect(await importDatabaseSnapshot(fixture, 'fixture-digest')).toBe('imported');
    expect(await exportDatabaseSnapshot()).toEqual(fixture);
    expect(await importDatabaseSnapshot(fixture, 'fixture-digest')).toBe('verified');
    await expect(importDatabaseSnapshot({ ...fixture, coins: { balance: 5, transactions: [] } }, 'other')).rejects.toThrow();
    expect(await exportDatabaseSnapshot()).toEqual(fixture);
  });
  test('attachment metadata round-trips and rejects paths escaping protected directories', async () => {
    expect(await readAttachmentMetadata('evidence')).toEqual(fixture.attachments![1]);
    await expect(upsertAttachmentMetadata({...fixture.attachments![1],path:'evidence/../auth.json'})).rejects.toThrow('Invalid protected attachment');
    expect((await exportDatabaseSnapshot()).attachments).toEqual(fixture.attachments!);
  });
  test('ledger appends preserve existing physical rows and note updates preserve other rows', async () => {
    const added={...fixture.coins.transactions[0],id:'new',timestamp:'2025-01-01T00:00:00Z'};
    await withStorageTransaction(async()=>{
      const before=(await currentDatabaseClient()!.query('SELECT ctid::text AS tuple FROM coin_ledger WHERE id=$1',['t'])).rows[0].tuple;
      await writeDocument('coins',{balance:0.5,transactions:[added,...fixture.coins.transactions]});
      const after=(await currentDatabaseClient()!.query('SELECT ctid::text AS tuple FROM coin_ledger WHERE id=$1',['t'])).rows[0].tuple;
      expect(after).toBe(before);
      const addedBefore=(await currentDatabaseClient()!.query('SELECT ctid::text AS tuple FROM coin_ledger WHERE id=$1',['new'])).rows[0].tuple;
      await writeDocument('coins',{balance:0.5,transactions:[added,{...fixture.coins.transactions[0],note:'private note'}]});
      const addedAfter=(await currentDatabaseClient()!.query('SELECT ctid::text AS tuple FROM coin_ledger WHERE id=$1',['new'])).rows[0].tuple;
      expect(addedAfter).toBe(addedBefore);
    });
    expect((await readDocument<DatabaseSnapshot['coins']>('coins'))!.transactions.map(transaction=>transaction.id)).toEqual(['new','t']);
    await writeDocument('coins',fixture.coins);
  });
  test('invalid financial values and duplicate identities roll back the full write', async () => {
    const invalid={habits:[{...fixture.habits.habits[0],coinReward:Number.NaN}]};
    await expect(writeDocument('habits',invalid)).rejects.toThrow('finite');
    expect(await readDocument<DatabaseSnapshot['habits']>('habits')).toEqual(fixture.habits);
    await expect(writeAuthDocument({users:[...fixture.auth.users,{id:'collision',username:'Other',authentikSubject:'subject',oidcIssuer:'https://identity.example.test/'}]})).rejects.toThrow();
    expect(await readAuthDocument()).toEqual(fixture.auth);
  });
  test('stale document revisions cannot overwrite newer ledger state', async () => {
    const revision = await getDocumentRevision('coins');
    await expect(writeDocument('coins', { balance: 900, transactions: [] }, revision! - 1)).rejects.toThrow('Data changed');
    expect(await readDocument<DatabaseSnapshot['coins']>('coins')).toEqual(fixture.coins);
  });
  test('same checked-out connection is reused and failed compound write rolls back', async () => {
    await expect(withStorageTransaction(async () => {
      const client = currentDatabaseClient();
      await withStorageTransaction(async () => expect(currentDatabaseClient() === client).toBe(true));
      await writeDocument('coins', { balance: 50, transactions: [] });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await readDocument<DatabaseSnapshot['coins']>('coins')).toEqual(fixture.coins);
  });
  test('after-commit cleanup runs once outside the transaction and is discarded on rollback', async () => {
    let completed=0;
    const result=await withStorageTransaction(async()=>{
      await withStorageTransaction(async()=>{
        await afterStorageCommit(async()=>{expect(currentDatabaseClient()).toBeUndefined();completed++;});
      });
      await afterStorageCommit(async()=>{throw new Error('cleanup failure');});
      expect(completed).toBe(0);
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(completed).toBe(1);
    await expect(withStorageTransaction(async()=>{
      await afterStorageCommit(async()=>{completed++;});
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(completed).toBe(1);
  });
  test('an ambient insecure SSL mode cannot override the validated private endpoint', async () => {
    const previous=process.env.PGSSLMODE;
    await closeDatabase();
    process.env.PGSSLMODE='no-verify';
    try {
      await withStorageTransaction(async()=>{expect((await currentDatabaseClient()!.query('SELECT 1 AS value')).rows[0].value).toBe(1);},{readOnly:true});
    } finally {
      if(previous===undefined)delete process.env.PGSSLMODE;else process.env.PGSSLMODE=previous;
      await closeDatabase();
    }
  });
  test('a caught nested failure cannot commit earlier financial changes', async () => {
    await expect(withStorageTransaction(async () => {
      await writeDocument('coins',{balance:99,transactions:[]});
      try { await withStorageTransaction(async () => {throw new Error('inner failure')}); } catch {}
    })).rejects.toThrow('Nested database operation failed');
    expect(await readDocument<DatabaseSnapshot['coins']>('coins')).toEqual(fixture.coins);
  });
  test('read-only snapshots reject nested writes and direct SQL writes', async () => {
    await expect(withStorageTransaction(async () => {
      await writeDocument('coins', { balance: 500, transactions: [] });
    }, { readOnly: true })).rejects.toThrow('read-only');
    await expect(withStorageTransaction(async () => {
      await currentDatabaseClient()!.query('DELETE FROM coin_ledger');
    }, { readOnly: true })).rejects.toThrow();
  });
  test('independent transactions serialize read-modify-write across connections', async () => {
    await Promise.all(Array.from({ length: 8 }, () => withStorageTransaction(async () => {
      const coins = await readDocument<{
        balance: number;
        transactions: unknown[];
      }>('coins');
      await writeDocument('coins', { ...coins, balance: coins!.balance + 0.25 });
    })));
    expect((await readDocument<{
      balance: number;
    }>('coins'))!.balance).toBe(2.25);
  });
});
