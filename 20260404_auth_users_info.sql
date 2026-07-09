CREATE OR REPLACE FUNCTION get_auth_users_info(user_ids uuid[])
RETURNS TABLE(id uuid, email text)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT id, email::text FROM auth.users WHERE id = ANY(user_ids);
$$;
