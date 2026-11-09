# Swiss 4000ers – private app

Private finder and tour log for the 48 Swiss 4000 m peaks. Only invited users can log in.

- **Hosting:** GitHub Pages (this repo contains code only, no route data).
- **Login, logs, route data:** Supabase (data stored in a private bucket; each user only sees their own log).
- **Admin:** nordmannjean@gmail.com can invite friends from the Admin tab (temporary password).

Setup files: `supabase-schema.sql` (database, run once) and `supabase-admin-users-function.ts` (Supabase edge function "admin-users" for invites).
