-- Only the API server's secret key may invoke these functions. The chatbot schema
-- stays private; SECURITY INVOKER retains the caller's privileges and RLS behavior.
GRANT USAGE ON SCHEMA chatbot TO service_role;
GRANT SELECT, INSERT, UPDATE ON chatbot.documents, chatbot.lead_sync_outbox TO service_role;
GRANT USAGE, SELECT ON SEQUENCE chatbot.documents_position_seq TO service_role;

CREATE FUNCTION public.chatbot_repository_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'documents', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'entity', d.entity, 'id', d.id, 'body', d.body) ORDER BY d.position)
      FROM chatbot.documents d), '[]'::jsonb),
    'outbox', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.opportunity_id)
      FROM chatbot.lead_sync_outbox o), '[]'::jsonb)
  );
$$;
REVOKE ALL ON FUNCTION public.chatbot_repository_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chatbot_repository_snapshot() TO service_role;

CREATE FUNCTION public.chatbot_repository_commit(expected jsonb, documents jsonb, outbox jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  item jsonb;
BEGIN
  IF jsonb_typeof(expected) IS DISTINCT FROM 'object'
    OR jsonb_typeof(documents) IS DISTINCT FROM 'array'
    OR jsonb_typeof(outbox) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_REPOSITORY_COMMIT' USING ERRCODE = '22023';
  END IF;

  -- Shared with the legacy PostgreSQL repository. Never hold this lock over HTTP.
  PERFORM pg_catalog.pg_advisory_xact_lock(724193810);
  IF public.chatbot_repository_snapshot() IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'REPOSITORY_SNAPSHOT_CHANGED' USING ERRCODE = '40001';
  END IF;

  -- Loop to preserve insertion order, including evaluations with equal timestamps.
  FOR item IN SELECT value FROM jsonb_array_elements(documents) LOOP
    INSERT INTO chatbot.documents (entity, id, body)
    VALUES (item->>'entity', item->>'id', item->'body')
    ON CONFLICT (entity, id) DO UPDATE SET body = EXCLUDED.body;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(outbox) LOOP
    INSERT INTO chatbot.lead_sync_outbox
      (opportunity_id, version, snapshot, snapshot_hash, attempts, status,
       next_attempt_at, last_error_code, updated_at)
    VALUES (item->>'opportunity_id', (item->>'version')::bigint,
      item->>'snapshot', item->>'snapshot_hash', (item->>'attempts')::integer,
      item->>'status', item->>'next_attempt_at', item->>'last_error_code', item->>'updated_at')
    ON CONFLICT (opportunity_id) DO UPDATE SET
      version = EXCLUDED.version, snapshot = EXCLUDED.snapshot,
      snapshot_hash = EXCLUDED.snapshot_hash, attempts = EXCLUDED.attempts,
      status = EXCLUDED.status, next_attempt_at = EXCLUDED.next_attempt_at,
      last_error_code = EXCLUDED.last_error_code, updated_at = EXCLUDED.updated_at;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.chatbot_repository_commit(jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chatbot_repository_commit(jsonb, jsonb, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
