-- Applied after import, in the same transaction. Never disabled for runtime.
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit entries are append-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER instance_activity_no_update BEFORE UPDATE OR DELETE ON instance_activity
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE FUNCTION protect_master() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_master = 1 THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Admin Master cannot be deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.is_master <> 1 OR NEW.role <> 'admin' OR NEW.active <> 1 OR NEW.id <> OLD.id THEN
      RAISE EXCEPTION 'Admin Master is protected' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_master_update BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION protect_master();

CREATE FUNCTION assign_message_api_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO api_messages(message_id) VALUES(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER message_api_id AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION assign_message_api_id();
