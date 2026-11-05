import { isDeepStrictEqual } from 'node:util';
import type { UserData, HabitsData, WishlistData, CoinsData, Settings, User, Habit, HabitCompletionRecord, WishlistItemType, CoinTransaction } from '../types';
import { currentDatabaseClient, withStorageTransaction } from './client';
export type DocumentKind = 'habits' | 'wishlist' | 'coins' | 'settings';
type StoredKind = DocumentKind | 'auth' | 'admin';
export interface DatabaseSnapshot {
  auth: UserData;
  habits: HabitsData;
  wishlist: WishlistData;
  coins: CoinsData;
  settings: Settings;
  adminConfig?: unknown;
  attachments?: AttachmentMetadata[];
}
export interface AttachmentMetadata {
  id:string;
  habit_id?:string;
  completion_id?:string;
  owner_id?:string;
  path:string;
  mime_type:'image/jpeg'|'image/png'|'image/webp'|'image/gif'|'image/avif';
  sha256:string;
}
export class StaleDocumentError extends Error {
  constructor() { super('Data changed; reload before saving'); this.name = 'StaleDocumentError'; }
}
type Json = Record<string, unknown>;
type Attributes = {fields:Json;present:string[];completionCount:number;recordCount:number};
interface DatabaseRow {
  family_id:string | null;
  attributes:Attributes;
  metadata:Attributes & {balance:number;scalar:boolean};
  revision:string;
  source_digest:string;
  id:string;
  user_id:string;
  actor_id:string;
  beneficiary_id:string;
  related_item_id:string;
  completion_id:string;
  request_id:string;
  reviewed_by:string;
  evidence_id:string;
  evidence_mime:HabitCompletionRecord['evidenceMime'];
  approval:HabitCompletionRecord['approval'];
  voided:boolean;
  ordinal:number;
  username:string;
  password_hash:string;
  email:string;
  is_admin:boolean;
  auth_version:number;
  issuer:string;
  subject:string;
  resource:string;
  can_write:boolean;
  can_interact:boolean;
  member_id:string;
  name:string;
  item_id:string;
  token_hash:string;
  created_by:string;
  managed_by:string;
  requires_approval:boolean;
  archived:boolean;
  coin_reward:string;
  coin_cost:string;
  amount:string;
  penalty:string;
  reward_amount:string;
  timestamp_text:string;
  record_kind:string;
  type:CoinTransaction['type'];
  value:unknown;
  habit_id:string;
  owner_id:string;
  path:string;
  mime_type:AttachmentMetadata['mime_type'];
  sha256:string;
}
const query = (sql: string, params: unknown[] = []) => {
  const client = currentDatabaseClient();
  if (!client)
    throw new Error('Database operation requires a transaction');
  return client.query(sql, params);
};
const rows = async (sql: string, params: unknown[] = []): Promise<DatabaseRow[]> => (await query(sql, params)).rows;
const encode = (value: unknown): string => JSON.stringify(value);
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid database document');
  return value as Json;
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Coin amounts must be finite numbers');
  return value;
}
function attributes(value: object, normalized: string[]): Json {
  const input = value as Json;
  const fields = { ...input };
  const present = normalized.filter(key => Object.hasOwn(input, key) && input[key] !== undefined);
  for (const key of normalized)
    delete fields[key];
  return { fields, present };
}
function restore(row: DatabaseRow): Json { return { ...row.attributes.fields }; }
function has(row: DatabaseRow, key: string): boolean { return row.attributes.present.includes(key); }
type FamilyStorageContext = { actorId:string; familyId?:string; siteAdmin:boolean };
async function familyStorageContext(requireFamily = true):Promise<FamilyStorageContext | undefined> {
  const installed = await query("SELECT to_regclass('habittrove.family_configuration') AS name");
  if (!installed.rows[0].name) return undefined;
  if (!(await query('SELECT enabled FROM habittrove.family_configuration WHERE singleton')).rows[0]?.enabled) return undefined;
  const state = (await query(`SELECT current_setting('habittrove.actor_id',true) AS actor,
    current_setting('habittrove.family_id',true) AS family,
    current_setting('habittrove.scope_validated',true) AS validated,
    current_setting('habittrove.site_admin',true) AS admin`)).rows[0];
  if (!state.actor || (requireFamily && (!state.family || state.validated !== 'true'))) throw new Error('Validated family context required');
  return {actorId:state.actor, familyId:state.validated === 'true' ? state.family || undefined : undefined, siteAdmin:state.admin === 'true'};
}
function validateFamilyTag(data:unknown, context:FamilyStorageContext | undefined):void {
  if (context && Object.hasOwn(object(data),'familyId') && object(data).familyId !== context.familyId) throw new Error('Document belongs to a different family');
}
async function metadata(kind: StoredKind): Promise<DatabaseRow | undefined> {
  const context = kind === 'habits' || kind === 'wishlist' ? await familyStorageContext() : undefined;
  return context
    ? (await rows('SELECT metadata,revision FROM habittrove.family_document_revisions WHERE family_id=$1 AND kind=$2',[context.familyId,kind]))[0]
    : (await rows('SELECT metadata, revision FROM documents WHERE kind=$1', [kind]))[0];
}
async function mark(kind: StoredKind, value: Json, expected?: number): Promise<void> {
  const current = await metadata(kind);
  if (expected !== undefined && Number(current?.revision ?? 0) !== expected)
    throw new StaleDocumentError();
  const context = kind === 'habits' || kind === 'wishlist' ? await familyStorageContext() : undefined;
  if(context) {
    await query('INSERT INTO habittrove.family_document_revisions(family_id,kind,metadata) VALUES($1,$2,$3) ON CONFLICT(family_id,kind) DO UPDATE SET revision=family_document_revisions.revision+1,metadata=EXCLUDED.metadata',[context.familyId,kind,encode(value)]);
  } else await query('INSERT INTO documents(kind,metadata) VALUES($1,$2) ON CONFLICT(kind) DO UPDATE SET revision=documents.revision+1,metadata=EXCLUDED.metadata', [kind, encode(value)]);
}
export async function getDocumentRevision(kind: StoredKind): Promise<number | undefined> {
  return withStorageTransaction(async () => { const data = await metadata(kind); return data ? Number(data.revision) : undefined; }, { readOnly: true });
}
async function writeAuth(data: UserData, expected?: number): Promise<void> {
  object(data);
  await mark('auth', attributes(data, ['users', 'invites']), expected);
  await query('DELETE FROM permissions');
  await query('DELETE FROM oidc_identities');
  await query('DELETE FROM manager_assignments');
  await query('DELETE FROM folders');
  await query('DELETE FROM status_days');
  await query('DELETE FROM invitations');
  for (const [ordinal, user] of data.users.entries()) {
    await query('INSERT INTO users(id,ordinal,username,password_hash,email,is_admin,auth_version,attributes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET ordinal=EXCLUDED.ordinal,username=EXCLUDED.username,password_hash=EXCLUDED.password_hash,email=EXCLUDED.email,is_admin=EXCLUDED.is_admin,auth_version=EXCLUDED.auth_version,attributes=EXCLUDED.attributes', [user.id, ordinal, user.username, user.password ?? null, user.email ?? null, user.isAdmin ?? null, user.authVersion ?? null, encode(attributes(user, ['id', 'username', 'password', 'email', 'isAdmin', 'authVersion', 'oidcSubject', 'permissions', 'managedUserIds', 'personalFolders', 'statusDays']))]);
  }
  for (const user of data.users) {
    if (user.oidcSubject !== undefined)
      await query('INSERT INTO oidc_identities(user_id,issuer,subject) VALUES($1,$2,$3)', [user.id, user.oidcIssuer ?? null, user.oidcSubject]);
    for (const [ordinal, permission] of (user.permissions ?? []).entries())
      for (const resource of ['habit', 'wishlist', 'coins'] as const)
        await query('INSERT INTO permissions(user_id,ordinal,resource,can_write,can_interact) VALUES($1,$2,$3,$4,$5)', [user.id, ordinal, resource, permission[resource].write, permission[resource].interact]);
    for (const [ordinal, member] of (user.managedUserIds ?? []).entries())
      await query('INSERT INTO manager_assignments(manager_id,member_id,ordinal) VALUES($1,$2,$3)', [user.id, member, ordinal]);
    for (const [ordinal, folder] of (user.personalFolders ?? []).entries()) {
      await query('INSERT INTO folders(user_id,ordinal,id,name) VALUES($1,$2,$3,$4)', [user.id, ordinal, folder.id, folder.name]);
      for (const [position, itemId] of folder.itemIds.entries())
        await query('INSERT INTO folder_items(user_id,folder_ordinal,ordinal,item_id) VALUES($1,$2,$3,$4)', [user.id, ordinal, position, itemId]);
    }
    for (const [ordinal, status] of (user.statusDays ?? []).entries())
      await query('INSERT INTO status_days(user_id,ordinal,local_date,status) VALUES($1,$2,$3,$4)', [user.id, ordinal, status.date, status.status]);
  }
  await query('DELETE FROM users WHERE NOT(id=ANY($1::text[]))', [data.users.map(user => user.id)]);
  for (const [ordinal, invite] of (data.invites ?? []).entries())
    await query('INSERT INTO invitations(token_hash,ordinal,email,created_by,managed_by,expires_at,attributes) VALUES($1,$2,$3,$4,$5,$6,$7)', [invite.tokenHash, ordinal, invite.email, invite.createdBy, invite.managedBy ?? null, invite.expiresAt, encode(attributes(invite, ['tokenHash', 'email', 'createdBy', 'managedBy']))]);
}
async function readAuth(): Promise<UserData | undefined> {
  const meta = await metadata('auth');
  if (!meta)
    return undefined;
  const users: User[] = [];
  for (const row of await rows('SELECT * FROM users ORDER BY ordinal')) {
    const user = { ...restore(row), id: row.id, username: row.username } as User;
    if (has(row, 'password'))
      user.password = row.password_hash;
    if (has(row, 'email'))
      user.email = row.email;
    if (has(row, 'isAdmin'))
      user.isAdmin = row.is_admin;
    if (has(row, 'authVersion'))
      user.authVersion = row.auth_version;
    const identity = (await rows('SELECT * FROM oidc_identities WHERE user_id=$1', [row.id]))[0];
    if (identity)
      user.oidcSubject = identity.subject;
    if (identity?.issuer != null || has(row, 'oidcIssuer'))
      user.oidcIssuer = identity?.issuer ?? row.attributes.fields.oidcIssuer as string;
    if (has(row, 'permissions')) {
      user.permissions = [];
      for (const permission of await rows('SELECT * FROM permissions WHERE user_id=$1 ORDER BY ordinal', [row.id])) {
        user.permissions[permission.ordinal] ??= {} as NonNullable<User['permissions']>[number];
        user.permissions[permission.ordinal][permission.resource as 'habit' | 'wishlist' | 'coins'] = { write: permission.can_write, interact: permission.can_interact };
      }
    }
    if (has(row, 'managedUserIds'))
      user.managedUserIds = (await rows('SELECT member_id FROM manager_assignments WHERE manager_id=$1 ORDER BY ordinal', [row.id])).map(v => v.member_id);
    if (has(row, 'personalFolders')) {
      user.personalFolders = [];
      for (const folder of await rows('SELECT * FROM folders WHERE user_id=$1 ORDER BY ordinal', [row.id]))
        user.personalFolders.push({ id: folder.id, name: folder.name, itemIds: (await rows('SELECT item_id FROM folder_items WHERE user_id=$1 AND folder_ordinal=$2 ORDER BY ordinal', [row.id, folder.ordinal])).map(v => v.item_id) });
    }
    if (has(row, 'statusDays'))
      user.statusDays = (await rows("SELECT to_char(local_date,'YYYY-MM-DD') AS date,status FROM status_days WHERE user_id=$1 ORDER BY ordinal", [row.id])) as unknown as NonNullable<User['statusDays']>;
    users.push(user);
  }
  const result = { ...meta.metadata.fields, users } as UserData;
  if (meta.metadata.present.includes('invites'))
    result.invites = (await rows('SELECT * FROM invitations ORDER BY ordinal')).map(row => ({ ...restore(row), tokenHash: row.token_hash, email: row.email, createdBy: row.created_by, ...(has(row, 'managedBy') ? { managedBy: row.managed_by } : {}) })) as UserData['invites'];
  return result;
}
async function writeHabits(data: HabitsData, expected?: number): Promise<void> {
  const context=await familyStorageContext();
  validateFamilyTag(data,context);
  await mark('habits', attributes(object(data), context ? ['habits','familyId'] : ['habits']), expected);
  await query(context ? 'DELETE FROM habits WHERE family_id=$1' : 'DELETE FROM habits',context ? [context.familyId] : []);
  for (const [ordinal, habit] of data.habits.entries()) {
    const attrs = attributes(habit, ['id', 'name', 'createdBy', 'requiresApproval', 'archived', 'coinReward', 'userIds', 'approverIds', 'checklist', 'completions', 'completionRecords', 'slips']);
    attrs.completionCount = habit.completions.length;
    attrs.recordCount = habit.completionRecords?.length ?? 0;
    await query('INSERT INTO habits(id,ordinal,name,created_by,requires_approval,archived,coin_reward,attributes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [habit.id, ordinal, habit.name, habit.createdBy ?? null, habit.requiresApproval ?? null, habit.archived ?? null, finite(habit.coinReward), encode(attrs)]);
    for (const [position, userId] of (habit.userIds ?? []).entries())
      await query('INSERT INTO habit_assignees(habit_id,ordinal,user_id) VALUES($1,$2,$3)', [habit.id, position, userId]);
    for (const [position, userId] of (habit.approverIds ?? []).entries())
      await query('INSERT INTO habit_approvers(habit_id,ordinal,user_id) VALUES($1,$2,$3)', [habit.id, position, userId]);
    for (const [position, item] of (habit.checklist ?? []).entries())
      await query('INSERT INTO checklist_entries(habit_id,ordinal,id,text,completed) VALUES($1,$2,$3,$4,$5)', [habit.id, position, item.id, item.text, item.completed]);
    for (let position = 0;position < Math.max(habit.completions.length, habit.completionRecords?.length ?? 0);position++) {
      const record = habit.completionRecords?.[position];
      const timestamp = habit.completions[position];
      if (record?.rewardAmount !== undefined)
        finite(record.rewardAmount);
      await query('INSERT INTO completions(habit_id,ordinal,completed_at,timestamp_text,record_kind,id,actor_id,beneficiary_id,request_id,voided,approval,reward_amount,reviewed_by,reviewed_at,evidence_id,evidence_mime,attributes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)', [habit.id, position, timestamp ?? null, timestamp ?? null, record === null ? 'null' : record === undefined ? 'absent' : 'record', record?.id ?? null, record?.actorId ?? null, record?.beneficiaryId ?? null, record?.requestId ?? null, record?.voided ?? null, record?.approval ?? null, record?.rewardAmount ?? null, record?.reviewedBy ?? null, record?.reviewedAt ?? null, record?.evidenceId ?? null, record?.evidenceMime ?? null, record ? encode(attributes(record, ['id', 'actorId', 'beneficiaryId', 'requestId', 'voided', 'approval', 'rewardAmount', 'reviewedBy', 'evidenceId', 'evidenceMime', 'rewardedUserIds'])) : null]);
      for (const [recipientPosition, userId] of (record?.rewardedUserIds ?? []).entries())
        await query('INSERT INTO completion_recipients(habit_id,completion_ordinal,ordinal,user_id) VALUES($1,$2,$3,$4)', [habit.id, position, recipientPosition, userId]);
    }
    for (const [position, slip] of (habit.slips ?? []).entries())
      await query('INSERT INTO slips(habit_id,ordinal,id,actor_id,occurred_at,penalty,attributes) VALUES($1,$2,$3,$4,$5,$6,$7)', [habit.id, position, slip.id, slip.actorId, slip.timestamp, finite(slip.penaltyAmount), encode(attributes(slip, ['id', 'actorId', 'penaltyAmount']))]);
  }
}
async function readHabits(): Promise<HabitsData | undefined> {
  const context=await familyStorageContext();
  const meta = await metadata('habits');
  if (!meta)
    return undefined;
  const habits: Habit[] = [];
  for (const row of await rows(context ? 'SELECT * FROM habits WHERE family_id=$1 ORDER BY ordinal' : 'SELECT * FROM habits ORDER BY ordinal',context ? [context.familyId] : [])) {
    const habit = { ...restore(row), id: row.id, name: row.name, coinReward: Number(row.coin_reward), completions: [] } as unknown as Habit;
    if (has(row, 'createdBy'))
      habit.createdBy = row.created_by;
    if (has(row, 'requiresApproval'))
      habit.requiresApproval = row.requires_approval;
    if (has(row, 'archived'))
      habit.archived = row.archived;
    if (has(row, 'userIds'))
      habit.userIds = (await rows('SELECT user_id FROM habit_assignees WHERE habit_id=$1 ORDER BY ordinal', [row.id])).map(v => v.user_id);
    if (has(row, 'approverIds'))
      habit.approverIds = (await rows('SELECT user_id FROM habit_approvers WHERE habit_id=$1 ORDER BY ordinal', [row.id])).map(v => v.user_id);
    if (has(row, 'checklist'))
      habit.checklist = (await rows('SELECT id,text,completed FROM checklist_entries WHERE habit_id=$1 ORDER BY ordinal', [row.id])) as unknown as NonNullable<Habit['checklist']>;
    if (has(row, 'completionRecords'))
      habit.completionRecords = [];
    for (const completion of await rows('SELECT * FROM completions WHERE habit_id=$1 ORDER BY ordinal', [row.id])) {
      if (completion.ordinal < row.attributes.completionCount)
        habit.completions.push(completion.timestamp_text);
      if (habit.completionRecords && completion.ordinal < row.attributes.recordCount) {
        if (completion.record_kind !== 'record')
          habit.completionRecords.push(null);
        else {
          const record = { ...restore(completion), id: completion.id, actorId: completion.actor_id } as HabitCompletionRecord;
          if (has(completion, 'voided'))
            record.voided = completion.voided;
          if (has(completion, 'approval'))
            record.approval = completion.approval;
          if (has(completion, 'rewardAmount'))
            record.rewardAmount = Number(completion.reward_amount);
          if (has(completion, 'reviewedBy'))
            record.reviewedBy = completion.reviewed_by;
          if (has(completion, 'evidenceId'))
            record.evidenceId = completion.evidence_id;
          if (has(completion, 'evidenceMime'))
            record.evidenceMime = completion.evidence_mime;
          if (has(completion, 'beneficiaryId'))
            record.beneficiaryId = completion.beneficiary_id;
          if (has(completion, 'requestId'))
            record.requestId = completion.request_id;
          if (has(completion, 'rewardedUserIds'))
            record.rewardedUserIds = (await rows('SELECT user_id FROM completion_recipients WHERE habit_id=$1 AND completion_ordinal=$2 ORDER BY ordinal', [row.id, completion.ordinal])).map(v => v.user_id);
          habit.completionRecords.push(record);
        }
      }
    }
    if (has(row, 'slips'))
      habit.slips = (await rows('SELECT * FROM slips WHERE habit_id=$1 ORDER BY ordinal', [row.id])).map(slip => ({ ...restore(slip), id: slip.id, actorId: slip.actor_id, penaltyAmount: Number(slip.penalty) })) as Habit['slips'];
    habits.push(habit);
  }
  return { ...meta.metadata.fields, habits, ...(context ? {familyId:context.familyId} : {}) };
}
async function writeWishlist(data: WishlistData, expected?: number): Promise<void> {
  const context=await familyStorageContext();
  validateFamilyTag(data,context);
  await mark('wishlist', attributes(object(data), context ? ['items','familyId'] : ['items']), expected);
  await query(context ? 'DELETE FROM wishlist_items WHERE family_id=$1' : 'DELETE FROM wishlist_items',context ? [context.familyId] : []);
  for (const [ordinal, item] of data.items.entries()) {
    await query('INSERT INTO wishlist_items(id,ordinal,name,coin_cost,attributes) VALUES($1,$2,$3,$4,$5)', [item.id, ordinal, item.name, finite(item.coinCost), encode(attributes(item, ['id', 'name', 'coinCost', 'userIds']))]);
    for (const [position, userId] of (item.userIds ?? []).entries())
      await query('INSERT INTO wishlist_assignees(item_id,ordinal,user_id) VALUES($1,$2,$3)', [item.id, position, userId]);
  }
}
async function readWishlist(): Promise<WishlistData | undefined> {
  const context=await familyStorageContext();
  const meta = await metadata('wishlist');
  if (!meta)
    return undefined;
  const items: WishlistItemType[] = [];
  for (const row of await rows(context ? 'SELECT * FROM wishlist_items WHERE family_id=$1 ORDER BY ordinal' : 'SELECT * FROM wishlist_items ORDER BY ordinal',context ? [context.familyId] : [])) {
    const item = { ...restore(row), id: row.id, name: row.name, coinCost: Number(row.coin_cost) } as WishlistItemType;
    if (has(row, 'userIds'))
      item.userIds = (await rows('SELECT user_id FROM wishlist_assignees WHERE item_id=$1 ORDER BY ordinal', [row.id])).map(v => v.user_id);
    items.push(item);
  }
  return { ...meta.metadata.fields, items, ...(context ? {familyId:context.familyId} : {}) };
}
function transactionFromRow(row:DatabaseRow):CoinTransaction {
  const transaction={...restore(row),id:row.id,amount:Number(row.amount),type:row.type} as CoinTransaction;
  for(const [key,column] of [['userId','user_id'],['actorId','actor_id'],['relatedItemId','related_item_id'],['completionId','completion_id'],['requestId','request_id']] as const) {
    if(has(row,key))transaction[key]=row[column];
  }
  return transaction;
}

async function writeCoins(data:CoinsData,expected?:number):Promise<void> {
  const familyContext=await familyStorageContext(false);
  if(familyContext)return writeFamilyCoins(data,familyContext,expected);
  finite(data.balance);
  const existingRows=await rows('SELECT * FROM coin_ledger ORDER BY ordinal');
  const existing=new Map(existingRows.map(row=>[row.id,row]));
  const submittedIds=new Set(data.transactions.map(transaction=>transaction.id));
  if(submittedIds.size!==data.transactions.length)throw new Error('Duplicate coin transaction IDs');
  for(const transaction of data.transactions)finite(transaction.amount);
  await mark('coins',{...attributes(object(data),['transactions']),balance:data.balance},expected);
  const removed=existingRows.filter(row=>!submittedIds.has(row.id)).map(row=>row.id);
  if(removed.length)await query('DELETE FROM coin_ledger WHERE id=ANY($1::text[])',[removed]);

  const retained=existingRows.filter(row=>submittedIds.has(row.id));
  const firstExisting=data.transactions.findIndex(transaction=>existing.has(transaction.id));
  const lastExisting=data.transactions.findLastIndex(transaction=>existing.has(transaction.id));
  const existingOrder=data.transactions.filter(transaction=>existing.has(transaction.id)).map(transaction=>transaction.id);
  const onlyOuterInsertions=firstExisting<0 || data.transactions.slice(firstExisting,lastExisting+1).every(transaction=>existing.has(transaction.id));
  const retainsOrder=isDeepStrictEqual(existingOrder,retained.map(row=>row.id));
  const preserveOrdinals=onlyOuterInsertions && retainsOrder;
  const minimum=retained.length?Number(retained[0].ordinal):0;
  const maximum=retained.length?Number(retained[retained.length-1].ordinal):-1;

  for(const [position,transaction] of data.transactions.entries()) {
    const previous=existing.get(transaction.id);
    let ordinal=position;
    if(preserveOrdinals && firstExisting>=0) {
      ordinal=previous?Number(previous.ordinal):position<firstExisting?minimum-firstExisting+position:maximum+position-lastExisting;
    }
    if(!Number.isSafeInteger(ordinal) || ordinal < -2147483648 || ordinal > 2147483647)throw new Error('Coin transaction order capacity exceeded');
    if(previous && isDeepStrictEqual(transactionFromRow(previous),JSON.parse(encode(transaction)))) {
      if(Number(previous.ordinal)!==ordinal)await query('UPDATE coin_ledger SET ordinal=$2 WHERE id=$1',[transaction.id,ordinal]);
      continue;
    }
    await query(`INSERT INTO coin_ledger(id,ordinal,user_id,actor_id,related_item_id,completion_id,request_id,amount,type,occurred_at,attributes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(id) DO UPDATE SET ordinal=EXCLUDED.ordinal,user_id=EXCLUDED.user_id,actor_id=EXCLUDED.actor_id,
      related_item_id=EXCLUDED.related_item_id,completion_id=EXCLUDED.completion_id,request_id=EXCLUDED.request_id,
      amount=EXCLUDED.amount,type=EXCLUDED.type,occurred_at=EXCLUDED.occurred_at,attributes=EXCLUDED.attributes`,
      [transaction.id,ordinal,transaction.userId??null,transaction.actorId??null,transaction.relatedItemId??null,transaction.completionId??null,
       transaction.requestId??null,transaction.amount,transaction.type,transaction.timestamp,
       encode(attributes(transaction,['id','userId','actorId','relatedItemId','completionId','requestId','amount','type']))]);
  }
}
async function writeFamilyCoins(data:CoinsData,context:FamilyStorageContext,expected?:number):Promise<void> {
  const ids=data.transactions.map(transaction=>transaction.id);
  if(new Set(ids).size!==ids.length)throw new Error('Duplicate coin transaction IDs');
  const existing=new Map((await rows('SELECT * FROM coin_ledger WHERE id=ANY($1::text[])',[ids])).map(row=>[row.id,row]));
  const additions:CoinTransaction[]=[];
  for(const transaction of data.transactions) {
    finite(transaction.amount);
    if(transaction.note!==undefined && typeof transaction.note!=='string')throw new Error('Invalid transaction note');
    const previous=existing.get(transaction.id);
    if(!previous) {
      if(!context.familyId)throw new Error('Validated family context required for ledger additions');
      additions.push(transaction);
      continue;
    }
    const old=transactionFromRow(previous);
    const withoutNote=(value:CoinTransaction)=>{const fields={...value};delete fields.note;return JSON.parse(encode(fields));};
    if(!isDeepStrictEqual(withoutNote(old),withoutNote(transaction)))throw new Error('Existing financial records are immutable');
  }
  const meta=await metadata('coins');
  // Family DTOs contain partial histories. Preserve global metadata and every omitted row.
  await mark('coins',meta?.metadata as unknown as Json ?? {fields:{balance:0},present:['transactions'],balance:0},expected);
  for(const transaction of data.transactions) {
    const previous=existing.get(transaction.id);
    if(!previous || transactionFromRow(previous).note===transaction.note)continue;
    const nextAttributes={...previous.attributes,fields:{...previous.attributes.fields}};
    if(transaction.note===undefined)delete nextAttributes.fields.note;
    else nextAttributes.fields.note=transaction.note;
    const result=await query('UPDATE coin_ledger SET attributes=$2 WHERE id=$1',[transaction.id,encode(nextAttributes)]);
    if(result.rowCount!==1)throw new Error('Transaction note access denied');
  }
  // Newest entries are first in the DTO. Allocate from oldest to newest so prepend
  // order is stable without touching existing rows, including hidden family origins.
  for(const transaction of additions.toReversed()) {
    await query(`INSERT INTO coin_ledger(id,ordinal,user_id,actor_id,related_item_id,completion_id,request_id,amount,type,occurred_at,attributes,family_id)
      VALUES($1,nextval('habittrove.coin_ledger_family_order'),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [transaction.id,transaction.userId??null,transaction.actorId??null,transaction.relatedItemId??null,transaction.completionId??null,
       transaction.requestId??null,transaction.amount,transaction.type,transaction.timestamp,
       encode(attributes(transaction,['id','userId','actorId','relatedItemId','completionId','requestId','amount','type'])),context.familyId]);
  }
}
async function readCoins():Promise<CoinsData|undefined> {
  const context=await familyStorageContext(false);
  const meta=await metadata('coins');if(!meta)return undefined;
  const transactions=(await rows(context
    ? 'SELECT * FROM coin_ledger WHERE user_id=$1 OR family_id=$2 ORDER BY ordinal,id'
    : 'SELECT * FROM coin_ledger ORDER BY ordinal',context?[context.actorId,context.familyId??null]:[])).map(transactionFromRow);
  return {...meta.metadata.fields,balance:meta.metadata.balance,transactions};
}
export async function readCompletionLedger(habitId:string,completionId?:string,beneficiaryId?:string):Promise<CoinTransaction[]> {
  return withStorageTransaction(async()=>{
    const context=await familyStorageContext();
    if(!context)throw new Error('Completion ledger access requires families');
    if(!habitId || (!completionId && !beneficiaryId))throw new Error('A completion or legacy beneficiary is required');
    let actualBeneficiaryId=beneficiaryId;
    if(completionId) {
      const completion=(await query('SELECT COALESCE(beneficiary_id,actor_id) AS beneficiary FROM completions WHERE family_id=$1 AND habit_id=$2 AND id=$3',[context.familyId,habitId,completionId])).rows[0];
      if(!completion)throw new Error('Completion ledger access denied');
      actualBeneficiaryId=completion.beneficiary??undefined;
      if(beneficiaryId!==undefined && beneficiaryId!==actualBeneficiaryId)throw new Error('Completion beneficiary mismatch');
    }
    const authorization=await query(`SELECT h.id FROM habits h WHERE h.family_id=$1 AND h.id=$2 AND
      ($3::boolean OR h.created_by=$4 OR EXISTS(SELECT 1 FROM habit_assignees a WHERE a.habit_id=h.id AND a.family_id=$1 AND a.user_id=$4)
      OR EXISTS(SELECT 1 FROM habit_approvers a WHERE a.habit_id=h.id AND a.family_id=$1 AND a.user_id=$4)
      OR EXISTS(SELECT 1 FROM completions c WHERE c.habit_id=h.id AND c.family_id=$1 AND c.id=$5 AND c.actor_id=$4)
      OR EXISTS(SELECT 1 FROM family_manager_assignments a WHERE a.family_id=$1 AND a.manager_id=$4 AND a.member_id=$6))`,
      [context.familyId,habitId,context.siteAdmin,context.actorId,completionId??null,actualBeneficiaryId??null]);
    if(!authorization.rowCount)throw new Error('Completion ledger access denied');
    if(!completionId) {
      const assignees=await query('SELECT user_id FROM habit_assignees WHERE family_id=$1 AND habit_id=$2',[context.familyId,habitId]);
      if(assignees.rowCount!==1 || assignees.rows[0].user_id!==beneficiaryId || (!context.siteAdmin && context.actorId!==beneficiaryId))throw new Error('Legacy completion ledger access denied');
    }
    const keys=['ledger_habit','ledger_completion','ledger_beneficiary'];
    const prior=(await query(`SELECT ${keys.map(key=>`current_setting('habittrove.${key}',true) AS ${key}`).join(',')}`)).rows[0];
    await query("SELECT set_config('habittrove.ledger_habit',$1,true),set_config('habittrove.ledger_completion',$2,true),set_config('habittrove.ledger_beneficiary',$3,true)",[habitId,completionId??'',actualBeneficiaryId??'']);
    try {
      return (await rows(`SELECT * FROM coin_ledger WHERE family_id=$1 AND related_item_id=$2
        AND type IN ('HABIT_COMPLETION','TASK_COMPLETION','HABIT_UNDO','TASK_UNDO')
        AND (($3::text IS NOT NULL AND completion_id=$3) OR ($3 IS NULL AND completion_id IS NULL AND user_id=$4)) ORDER BY ordinal,id`,
        [context.familyId,habitId,completionId??null,actualBeneficiaryId??null])).map(transactionFromRow);
    } finally {
      await query(`SELECT ${keys.map((key,index)=>`set_config('habittrove.${key}',$${index+1},true)`).join(',')}`,keys.map(key=>prior[key]??'')).catch(()=>undefined);
    }
  },{readOnly:true});
}
export async function readDocument<T>(kind: DocumentKind): Promise<T | undefined> {
  return withStorageTransaction(async () => {
    if (kind === 'habits')
      return await readHabits() as T | undefined;
    if (kind === 'wishlist')
      return await readWishlist() as T | undefined;
    if (kind === 'coins')
      return await readCoins() as T | undefined;
    if (kind !== 'settings')
      throw new Error('Unknown document kind');
    if (!await metadata('settings'))
      return undefined;
    return Object.fromEntries((await rows('SELECT name,value FROM setting_sections')).map(row => [row.name, row.value])) as T;
  }, { readOnly: true });
}
export async function writeDocument<T>(kind: DocumentKind, data: T, expectedRevision?: number): Promise<void> {
  return withStorageTransaction(async () => {
    if (kind === 'habits')
      return writeHabits(data as HabitsData, expectedRevision);
    if (kind === 'wishlist')
      return writeWishlist(data as WishlistData, expectedRevision);
    if (kind === 'coins')
      return writeCoins(data as CoinsData, expectedRevision);
    if (kind !== 'settings')
      throw new Error('Unknown document kind');
    await mark('settings', {}, expectedRevision);
    await query('DELETE FROM setting_sections');
    for (const [key, value] of Object.entries(object(data)))
      if (value !== undefined)
        await query('INSERT INTO setting_sections(name,value) VALUES($1,$2)', [key, encode(value)]);
  });
}
export async function readAuthDocument(): Promise<UserData | undefined> { return withStorageTransaction(readAuth, { readOnly: true }); }
export async function writeAuthDocument(data: UserData, expectedRevision?: number): Promise<void> { return withStorageTransaction(() => writeAuth(data, expectedRevision)); }
export async function readAdminDocument<T>(): Promise<T | undefined> {
  return withStorageTransaction(async () => {
    const meta = await metadata('admin');
    if (!meta)
      return undefined;
    if (meta.metadata.scalar)
      return (await rows('SELECT value FROM admin_configuration WHERE name=$1', ['value']))[0]?.value as T;
    return Object.fromEntries((await rows('SELECT name,value FROM admin_configuration')).map(row => [row.name, row.value])) as T;
  }, { readOnly: true });
}
export async function writeAdminDocument(data: unknown, expectedRevision?: number): Promise<void> {
  return withStorageTransaction(async () => {
    const scalar = data === null || typeof data !== 'object' || Array.isArray(data);
    await mark('admin', { scalar }, expectedRevision);
    await query('DELETE FROM admin_configuration');
    for (const [key, value] of Object.entries(scalar ? { value: data } : data as Json))
      if (value !== undefined)
        await query('INSERT INTO admin_configuration(name,value) VALUES($1,$2)', [key, encode(value)]);
  });
}
function validateAttachment(value:AttachmentMetadata):void {
  if(!value || typeof value.id!=='string' || !value.id || value.id.length>255 ||
    typeof value.path!=='string' || !/^(evidence|avatars)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(value.path) ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(value.mime_type) ||
    [value.habit_id,value.completion_id,value.owner_id].some(id=>id!==undefined && (typeof id!=='string' || !id || id.length>255))) {
    throw new Error('Invalid protected attachment metadata');
  }
  if(value.path.startsWith('evidence/') && ['image/gif','image/avif'].includes(value.mime_type))throw new Error('Unsupported evidence MIME type');
}
export async function upsertAttachmentMetadata(value:AttachmentMetadata):Promise<void> {
  validateAttachment(value);
  await withStorageTransaction(async()=>{
    await query(`INSERT INTO attachments(id,habit_id,completion_id,owner_id,path,mime_type,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET habit_id=EXCLUDED.habit_id,completion_id=EXCLUDED.completion_id,owner_id=EXCLUDED.owner_id,
      path=EXCLUDED.path,mime_type=EXCLUDED.mime_type,sha256=EXCLUDED.sha256`,
      [value.id,value.habit_id??null,value.completion_id??null,value.owner_id??null,value.path,value.mime_type,value.sha256]);
  });
}
export async function removeAttachmentMetadata(id:string):Promise<void> {
  await withStorageTransaction(async()=>{await query('DELETE FROM attachments WHERE id=$1',[id]);});
}
export async function readAttachmentMetadata(id:string):Promise<AttachmentMetadata|undefined> {
  return withStorageTransaction(async()=>{
    const row=(await rows('SELECT * FROM attachments WHERE id=$1',[id]))[0];
    return row?attachmentFromRow(row):undefined;
  },{readOnly:true});
}
function attachmentFromRow(row:DatabaseRow):AttachmentMetadata {
  return {id:row.id,path:row.path,mime_type:row.mime_type,sha256:row.sha256,
    ...(row.habit_id===null?{}:{habit_id:row.habit_id}),...(row.completion_id===null?{}:{completion_id:row.completion_id}),
    ...(row.owner_id===null?{}:{owner_id:row.owner_id})};
}
function canonicalSnapshot(snapshot:DatabaseSnapshot):DatabaseSnapshot {
  const result=JSON.parse(encode(snapshot)) as DatabaseSnapshot;
  if(result.attachments?.length)result.attachments.sort((a,b)=>a.id.localeCompare(b.id,'en'));
  else delete result.attachments;
  return result;
}
export async function exportDatabaseSnapshot(): Promise<DatabaseSnapshot> {
  return withStorageTransaction(async () => {
    const auth = await readAuthDocument(), habits = await readDocument<HabitsData>('habits'), wishlist = await readDocument<WishlistData>('wishlist'), coins = await readDocument<CoinsData>('coins'), settings = await readDocument<Settings>('settings');
    if (!auth || !habits || !wishlist || !coins || !settings)
      throw new Error('Database snapshot is incomplete');
    const adminConfig = await readAdminDocument();
    const attachments=(await rows('SELECT * FROM attachments')).map(attachmentFromRow).sort((a,b)=>a.id.localeCompare(b.id,'en'));
    return { auth, habits, wishlist, coins, settings, ...(adminConfig === undefined ? {} : { adminConfig }), ...(attachments.length?{attachments}:{}) };
  }, { readOnly: true });
}
export async function importDatabaseSnapshot(snapshot: DatabaseSnapshot, sourceDigest: string): Promise<'imported' | 'verified'> {
  if (!sourceDigest || sourceDigest.length > 256)
    throw new Error('Invalid source digest');
  return withStorageTransaction(async () => {
    const batches = await rows('SELECT source_digest FROM migration_batches');
    if (batches.length) {
      if (batches.length !== 1 || batches[0].source_digest !== sourceDigest || !isDeepStrictEqual(await exportDatabaseSnapshot(), canonicalSnapshot(snapshot)))
        throw new Error('Import target differs from source');
      return 'verified';
    }
    // All user-data tables are checked, including rows not represented by document presence markers.
    const tableNames = ['documents', 'users', 'invitations', 'habits', 'wishlist_items', 'coin_ledger', 'setting_sections', 'admin_configuration', 'attachments', 'authentication_throttles', 'job_leases'];
    for (const table of tableNames)
      if ((await rows(`SELECT 1 FROM ${table} LIMIT 1`)).length)
        throw new Error('Import requires an empty target database');
    await writeAuth(snapshot.auth);
    await writeHabits(snapshot.habits);
    await writeWishlist(snapshot.wishlist);
    await writeCoins(snapshot.coins);
    await writeDocument('settings', snapshot.settings);
    if (snapshot.adminConfig !== undefined)
      await writeAdminDocument(snapshot.adminConfig);
    const attachmentIds=new Set<string>();
    for(const attachment of snapshot.attachments??[]) {
      if(attachmentIds.has(attachment.id))throw new Error('Duplicate attachment IDs');
      attachmentIds.add(attachment.id);await upsertAttachmentMetadata(attachment);
    }
    if (!isDeepStrictEqual(await exportDatabaseSnapshot(), canonicalSnapshot(snapshot)))
      throw new Error('Imported data did not round-trip exactly');
    await query('INSERT INTO migration_batches(source_digest) VALUES($1)', [sourceDigest]);
    return 'imported';
  });
}
