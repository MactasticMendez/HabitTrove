-- Stage B is applied separately after Stage A acceptance. Unmapped rows remain private when enabled.
SET LOCAL search_path = habittrove, pg_catalog;
CREATE TABLE family_configuration (singleton boolean PRIMARY KEY CHECK(singleton), enabled boolean NOT NULL DEFAULT false);
INSERT INTO family_configuration VALUES(true,false);
CREATE TABLE families (id text PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE family_memberships (
  family_id text REFERENCES families, user_id text REFERENCES users, role text NOT NULL CHECK(role IN ('owner','manager','member')),
  active boolean NOT NULL DEFAULT true, joined_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz,
  PRIMARY KEY(family_id,user_id)
);
CREATE TABLE family_manager_assignments (
  family_id text NOT NULL, manager_id text NOT NULL, member_id text NOT NULL,
  PRIMARY KEY(family_id,manager_id,member_id), CHECK(manager_id <> member_id),
  FOREIGN KEY(family_id,manager_id) REFERENCES family_memberships,
  FOREIGN KEY(family_id,member_id) REFERENCES family_memberships
);
CREATE TABLE family_permissions (
  family_id text NOT NULL, user_id text NOT NULL, resource text NOT NULL CHECK(resource IN ('habit','wishlist','coins')),
  can_write boolean NOT NULL DEFAULT false, can_interact boolean NOT NULL DEFAULT false,
  PRIMARY KEY(family_id,user_id,resource), FOREIGN KEY(family_id,user_id) REFERENCES family_memberships
);
CREATE TABLE family_preferences (
  family_id text NOT NULL, user_id text NOT NULL, preferences jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(family_id,user_id), FOREIGN KEY(family_id,user_id) REFERENCES family_memberships
);
CREATE TABLE family_settings (family_id text PRIMARY KEY REFERENCES families, settings jsonb NOT NULL DEFAULT '{}');
CREATE TABLE household_invitations (
  token_hash text PRIMARY KEY CHECK(length(token_hash)=64), family_id text NOT NULL REFERENCES families,
  email text NOT NULL CHECK(email=lower(email)), role text NOT NULL CHECK(role IN ('member','manager')),
  created_by text NOT NULL, managed_by text, expires_at timestamptz NOT NULL,
  consumed_at timestamptz, consumed_by text, revoked_at timestamptz,
  FOREIGN KEY(family_id,created_by) REFERENCES family_memberships,
  FOREIGN KEY(family_id,managed_by) REFERENCES family_memberships
);
CREATE INDEX household_invite_family ON household_invitations(family_id);
CREATE TABLE family_audit (id text PRIMARY KEY, family_id text NOT NULL REFERENCES families, actor_id text NOT NULL, action text NOT NULL, target_id text, occurred_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE family_legacy_adoptions (source_hash text PRIMARY KEY, family_id text NOT NULL REFERENCES families, actor_id text NOT NULL, mapping jsonb NOT NULL, adopted_at timestamptz NOT NULL DEFAULT now());

CREATE FUNCTION family_scope_matches(wanted text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT current_setting('habittrove.site_admin',true)='true' OR
   (current_setting('habittrove.scope_validated',true)='true' AND wanted=current_setting('habittrove.family_id',true))
$$;
CREATE FUNCTION family_legacy_mode() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT NOT enabled FROM habittrove.family_configuration WHERE singleton $$;

-- Only active managers/owners can receive delegations; no cross-family endpoints.
CREATE FUNCTION check_family_assignment() RETURNS trigger LANGUAGE plpgsql SET search_path=habittrove,pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM family_memberships WHERE family_id=NEW.family_id AND user_id=NEW.manager_id AND active AND role IN ('owner','manager')) OR
    NOT EXISTS(SELECT 1 FROM family_memberships WHERE family_id=NEW.family_id AND user_id=NEW.member_id AND active) THEN
   RAISE EXCEPTION 'Delegations require active family members and a manager';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER family_assignment_membership BEFORE INSERT OR UPDATE ON family_manager_assignments FOR EACH ROW EXECUTE FUNCTION check_family_assignment();
CREATE FUNCTION protect_family_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=habittrove,pg_catalog AS $$
BEGIN
 IF OLD.active AND OLD.role='owner' AND (TG_OP='DELETE' OR NOT NEW.active OR NEW.role <> 'owner') THEN
  PERFORM 1 FROM families WHERE id=OLD.family_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM family_memberships WHERE family_id=OLD.family_id AND active AND role='owner' AND user_id<>OLD.user_id) THEN
   RAISE EXCEPTION 'The last active family owner must remain';
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER family_last_owner BEFORE UPDATE OR DELETE ON family_memberships FOR EACH ROW EXECUTE FUNCTION protect_family_owner();

ALTER TABLE habits ADD COLUMN family_id text REFERENCES families;
ALTER TABLE habits ADD UNIQUE(family_id,id);
ALTER TABLE wishlist_items ADD COLUMN family_id text REFERENCES families;
ALTER TABLE wishlist_items ADD UNIQUE(family_id,id);
ALTER TABLE coin_ledger ADD COLUMN family_id text REFERENCES families;
ALTER TABLE attachments ADD COLUMN family_id text REFERENCES families;
ALTER TABLE attachments ADD COLUMN inaccessible boolean NOT NULL DEFAULT false;
ALTER TABLE attachments ADD FOREIGN KEY(family_id,habit_id) REFERENCES habits(family_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE completions ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['habit_assignees','habit_approvers','checklist_entries','completions','completion_recipients','slips'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN family_id text REFERENCES families',t);
  EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY(family_id,habit_id) REFERENCES habits(family_id,id)',t);
 END LOOP;
END $$;
ALTER TABLE completions ADD UNIQUE(family_id,habit_id,ordinal);
ALTER TABLE completion_recipients ADD FOREIGN KEY(family_id,habit_id,completion_ordinal) REFERENCES completions(family_id,habit_id,ordinal);
ALTER TABLE wishlist_assignees ADD COLUMN family_id text REFERENCES families;
ALTER TABLE wishlist_assignees ADD FOREIGN KEY(family_id,item_id) REFERENCES wishlist_items(family_id,id);
ALTER TABLE habit_assignees ADD FOREIGN KEY(family_id,user_id) REFERENCES family_memberships;
ALTER TABLE habit_approvers ADD FOREIGN KEY(family_id,user_id) REFERENCES family_memberships;
ALTER TABLE wishlist_assignees ADD FOREIGN KEY(family_id,user_id) REFERENCES family_memberships;

CREATE FUNCTION check_active_family_assignee() RETURNS trigger LANGUAGE plpgsql SET search_path=habittrove,pg_catalog AS $$
BEGIN
 IF NEW.family_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM family_memberships WHERE family_id=NEW.family_id AND user_id=NEW.user_id AND active) THEN
  RAISE EXCEPTION 'Assignment requires active membership';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER active_habit_assignee BEFORE INSERT OR UPDATE ON habit_assignees FOR EACH ROW EXECUTE FUNCTION check_active_family_assignee();
CREATE TRIGGER active_habit_approver BEFORE INSERT OR UPDATE ON habit_approvers FOR EACH ROW EXECUTE FUNCTION check_active_family_assignee();
CREATE TRIGGER active_reward_assignee BEFORE INSERT OR UPDATE ON wishlist_assignees FOR EACH ROW EXECUTE FUNCTION check_active_family_assignee();

-- Global wallet summary contains no origin/item details. Its non-login table owner maintains it;
-- runtime receives SELECT only, and therefore cannot change totals independently of the ledger.
CREATE TABLE global_wallet_totals (user_id text PRIMARY KEY, balance numeric NOT NULL);
INSERT INTO global_wallet_totals SELECT user_id,sum(amount) FROM coin_ledger WHERE user_id IS NOT NULL GROUP BY user_id;
CREATE FUNCTION maintain_global_wallet() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=habittrove,pg_catalog AS $$
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') AND OLD.user_id IS NOT NULL THEN
  INSERT INTO global_wallet_totals VALUES(OLD.user_id,-OLD.amount) ON CONFLICT(user_id) DO UPDATE SET balance=global_wallet_totals.balance-OLD.amount;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') AND NEW.user_id IS NOT NULL THEN
  INSERT INTO global_wallet_totals VALUES(NEW.user_id,NEW.amount) ON CONFLICT(user_id) DO UPDATE SET balance=global_wallet_totals.balance+NEW.amount;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION maintain_global_wallet() FROM PUBLIC;
CREATE TRIGGER global_wallet_ledger AFTER INSERT OR UPDATE OR DELETE ON coin_ledger FOR EACH ROW EXECUTE FUNCTION maintain_global_wallet();
ALTER TABLE global_wallet_totals ENABLE ROW LEVEL SECURITY;
CREATE POLICY global_wallet_summary ON global_wallet_totals FOR SELECT USING (
 family_legacy_mode() OR current_setting('habittrove.site_admin',true)='true' OR user_id=current_setting('habittrove.actor_id',true) OR
 EXISTS(SELECT 1 FROM family_manager_assignments a WHERE a.family_id=current_setting('habittrove.family_id',true) AND family_scope_matches(a.family_id) AND a.manager_id=current_setting('habittrove.actor_id',true) AND a.member_id=global_wallet_totals.user_id)
);
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON global_wallet_totals FROM PUBLIC;

ALTER TABLE families ENABLE ROW LEVEL SECURITY;
ALTER TABLE families FORCE ROW LEVEL SECURITY;
CREATE POLICY family_directory ON families USING (
 current_setting('habittrove.site_admin',true)='true' OR
 EXISTS(SELECT 1 FROM family_memberships m WHERE m.family_id=families.id AND m.user_id=current_setting('habittrove.actor_id',true) AND m.active)
) WITH CHECK(current_setting('habittrove.site_admin',true)='true' OR (family_scope_matches(id) AND current_setting('habittrove.family_role',true)='owner'));
ALTER TABLE family_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY family_membership_read ON family_memberships FOR SELECT USING (user_id=current_setting('habittrove.actor_id',true) OR family_scope_matches(family_id));
CREATE POLICY family_membership_insert ON family_memberships FOR INSERT WITH CHECK(family_scope_matches(family_id) AND current_setting('habittrove.family_role',true) IN ('owner','site-admin'));
CREATE POLICY family_membership_update ON family_memberships FOR UPDATE USING(family_scope_matches(family_id) AND current_setting('habittrove.family_role',true) IN ('owner','site-admin')) WITH CHECK(family_scope_matches(family_id));
CREATE POLICY family_membership_delete ON family_memberships FOR DELETE USING(false);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['family_manager_assignments','family_permissions','family_preferences','family_settings','household_invitations','family_audit','family_legacy_adoptions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY family_boundary ON %I USING(family_scope_matches(family_id)) WITH CHECK(family_scope_matches(family_id))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['habits','habit_assignees','habit_approvers','checklist_entries','completions','completion_recipients','slips','wishlist_items','wishlist_assignees'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY family_boundary ON %I USING(family_legacy_mode() OR family_scope_matches(family_id)) WITH CHECK(family_legacy_mode() OR (family_id IS NOT NULL AND family_scope_matches(family_id)))',t);
 END LOOP;
END $$;
ALTER TABLE coin_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE coin_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY global_ledger_read ON coin_ledger FOR SELECT USING (
 family_legacy_mode() OR current_setting('habittrove.site_admin',true)='true' OR user_id=current_setting('habittrove.actor_id',true) OR
 (family_scope_matches(family_id) AND EXISTS(SELECT 1 FROM family_manager_assignments a WHERE a.family_id=coin_ledger.family_id AND a.manager_id=current_setting('habittrove.actor_id',true) AND a.member_id=coin_ledger.user_id))
);
CREATE POLICY family_ledger_insert ON coin_ledger FOR INSERT WITH CHECK(family_legacy_mode() OR (family_id IS NOT NULL AND family_scope_matches(family_id)));
CREATE POLICY family_ledger_update ON coin_ledger FOR UPDATE USING(family_legacy_mode() OR family_scope_matches(family_id)) WITH CHECK(family_legacy_mode() OR (family_id IS NOT NULL AND family_scope_matches(family_id)));
CREATE POLICY family_ledger_delete ON coin_ledger FOR DELETE USING(family_legacy_mode() OR family_scope_matches(family_id));
-- Grant only SELECT on global_wallet_totals to the runtime role after the migration; do not grant blanket table write privileges.

-- A token capability is used only inside the reviewed invite resolver/acceptance transaction.
CREATE POLICY invitation_token_read ON household_invitations FOR SELECT USING (
 token_hash=current_setting('habittrove.invite_token_hash',true) AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()
);
CREATE POLICY invitation_family_name ON families FOR SELECT USING (
 EXISTS(SELECT 1 FROM household_invitations i WHERE i.family_id=families.id AND i.token_hash=current_setting('habittrove.invite_token_hash',true) AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now())
);
CREATE POLICY invitation_authority_read ON family_memberships FOR SELECT USING (
 EXISTS(SELECT 1 FROM household_invitations i WHERE i.family_id=family_memberships.family_id AND i.token_hash=current_setting('habittrove.invite_token_hash',true) AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now())
);
ALTER TABLE household_invitations DROP CONSTRAINT household_invitations_family_id_created_by_fkey;
ALTER TABLE household_invitations ADD FOREIGN KEY(created_by) REFERENCES users(id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['habits','habit_assignees','habit_approvers','checklist_entries','completions','completion_recipients','slips','wishlist_items','wishlist_assignees','attachments','coin_ledger'] LOOP
  EXECUTE format('ALTER TABLE %I ALTER COLUMN family_id SET DEFAULT NULLIF(current_setting(''habittrove.family_id'',true),'''')',t);
 END LOOP;
END $$;

ALTER TABLE completions ADD UNIQUE(family_id,habit_id,id);
ALTER TABLE attachments ADD FOREIGN KEY(family_id,habit_id,completion_id) REFERENCES completions(family_id,habit_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION check_family_ledger_origin() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=habittrove,pg_catalog AS $$
DECLARE prior_admin text; invalid_origin boolean;
BEGIN
 IF NEW.family_id IS NULL THEN RETURN NEW; END IF;
 -- Missing historical item IDs remain historical; a live cross-family link is forbidden.
 -- Trigger-only validation needs to detect even an item hidden by RLS. The temporary
 -- capability is restored before row policy checks, returns no hidden row and performs no writes.
 prior_admin := current_setting('habittrove.site_admin',true);
 PERFORM set_config('habittrove.site_admin','true',true);
 SELECT EXISTS(SELECT 1 FROM habits WHERE id=NEW.related_item_id AND NEW.type<>'WISH_REDEMPTION' AND family_id IS DISTINCT FROM NEW.family_id) OR
        EXISTS(SELECT 1 FROM wishlist_items WHERE id=NEW.related_item_id AND NEW.type='WISH_REDEMPTION' AND family_id IS DISTINCT FROM NEW.family_id) INTO invalid_origin;
 PERFORM set_config('habittrove.site_admin',COALESCE(prior_admin,''),true);
 IF invalid_origin THEN RAISE EXCEPTION 'Ledger item belongs to a different family'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER family_ledger_origin BEFORE INSERT OR UPDATE OF family_id,related_item_id ON coin_ledger FOR EACH ROW EXECUTE FUNCTION check_family_ledger_origin();

REVOKE ALL ON FUNCTION check_family_ledger_origin() FROM PUBLIC;

-- Preserve review flags when the compatibility adapter recreates a completion from its DTO.
CREATE FUNCTION project_family_review_flag() RETURNS trigger LANGUAGE plpgsql SET search_path=habittrove,pg_catalog AS $$
BEGIN
 IF NEW.attributes #> '{fields,needsReview}' = 'true'::jsonb THEN NEW.needs_review := true; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER family_completion_review_flag BEFORE INSERT OR UPDATE ON completions FOR EACH ROW EXECUTE FUNCTION project_family_review_flag();


-- Avatars belong to the global identity. Evidence keeps its household boundary.
CREATE FUNCTION global_avatar_ownership() RETURNS trigger LANGUAGE plpgsql SET search_path=habittrove,pg_catalog AS $$
BEGIN
 IF NEW.path LIKE 'avatars/%' THEN
  IF NEW.habit_id IS NOT NULL OR NEW.completion_id IS NOT NULL THEN RAISE EXCEPTION 'Avatar metadata cannot reference evidence'; END IF;
  NEW.family_id := NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER global_avatar_metadata BEFORE INSERT OR UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION global_avatar_ownership();
UPDATE attachments SET family_id=NULL WHERE path LIKE 'avatars/%' AND habit_id IS NULL AND completion_id IS NULL;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachment_visibility ON attachments FOR SELECT USING (
 family_legacy_mode() OR current_setting('habittrove.site_admin',true)='true' OR
 (path LIKE 'avatars/%' AND habit_id IS NULL AND completion_id IS NULL AND
   (owner_id=current_setting('habittrove.actor_id',true) OR
    (current_setting('habittrove.scope_validated',true)='true' AND EXISTS(
      SELECT 1 FROM family_memberships m WHERE m.family_id=current_setting('habittrove.family_id',true) AND m.user_id=attachments.owner_id AND m.active)))) OR
 (path NOT LIKE 'avatars/%' AND (NOT inaccessible OR current_setting('habittrove.evidence_maintenance',true)='true') AND family_scope_matches(family_id))
);
CREATE POLICY attachment_insert ON attachments FOR INSERT WITH CHECK (
 family_legacy_mode() OR current_setting('habittrove.site_admin',true)='true' OR
 (path LIKE 'avatars/%' AND habit_id IS NULL AND completion_id IS NULL AND family_id IS NULL AND owner_id=current_setting('habittrove.actor_id',true)) OR
 (path NOT LIKE 'avatars/%' AND family_id IS NOT NULL AND family_scope_matches(family_id))
);
CREATE POLICY attachment_update ON attachments FOR UPDATE USING (
 family_legacy_mode() OR current_setting('habittrove.site_admin',true)='true' OR
 (path LIKE 'avatars/%' AND owner_id=current_setting('habittrove.actor_id',true)) OR
 (path NOT LIKE 'avatars/%' AND family_scope_matches(family_id))
) WITH CHECK (
 family_legacy_mode() OR current_setting('habittrove.site_admin',true)='true' OR
 (path LIKE 'avatars/%' AND habit_id IS NULL AND completion_id IS NULL AND family_id IS NULL AND owner_id=current_setting('habittrove.actor_id',true)) OR
 (path NOT LIKE 'avatars/%' AND family_id IS NOT NULL AND family_scope_matches(family_id))
);
CREATE POLICY attachment_delete ON attachments FOR DELETE USING (
 family_legacy_mode() OR current_setting('habittrove.site_admin',true)='true' OR
 (path LIKE 'avatars/%' AND owner_id=current_setting('habittrove.actor_id',true)) OR
 (path NOT LIKE 'avatars/%' AND family_scope_matches(family_id))
);
