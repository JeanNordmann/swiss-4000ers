// Supabase Edge Function "admin-users": lets the admin list, create, reset and delete user accounts.
// Only the admin e-mail can call it. The service-role key is provided by Supabase at runtime and never leaves the server.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") ?? "nordmannjean@gmail.com").toLowerCase();
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

function tempPassword(len = 12) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => abc[n % abc.length]).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user || (user.email ?? "").toLowerCase() !== ADMIN_EMAIL) return json({ error: "Only the admin can do this." }, 403);

    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "list": {
        const { data, error } = await admin.auth.admin.listUsers({ perPage: 500 });
        if (error) throw error;
        return json({ users: data.users.map((u) => ({
          id: u.id, email: u.email, name: u.user_metadata?.name ?? "", created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at, must_change: !!u.user_metadata?.must_change, is_admin: (u.email ?? "").toLowerCase() === ADMIN_EMAIL,
        })) });
      }
      case "create": {
        const email = String(body.email ?? "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Invalid e-mail address." }, 400);
        const password = tempPassword();
        const { data, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true, user_metadata: { must_change: true, name: String(body.name ?? "").trim() },
        });
        if (error) return json({ error: error.message }, 400);
        return json({ id: data.user?.id, email, password });
      }
      case "reset": {
        const { data: got, error: e1 } = await admin.auth.admin.getUserById(String(body.id));
        if (e1 || !got.user) return json({ error: "User not found." }, 404);
        const password = tempPassword();
        const { error } = await admin.auth.admin.updateUserById(got.user.id, {
          password, user_metadata: { ...(got.user.user_metadata ?? {}), must_change: true },
        });
        if (error) return json({ error: error.message }, 400);
        return json({ email: got.user.email, password });
      }
      case "delete": {
        if (String(body.id) === user.id) return json({ error: "You cannot delete your own admin account." }, 400);
        const { error } = await admin.auth.admin.deleteUser(String(body.id));
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
