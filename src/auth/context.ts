import { asSystem, sys, type Db } from "../db/pool.js";

export type AppRole = "admin" | "teacher" | "student" | "parent";
export const ROLE_PRIORITY: AppRole[] = ["admin", "teacher", "parent", "student"];
export const ROLE_HOME: Record<AppRole, string> = { admin: "/admin", teacher: "/teacher", student: "/student", parent: "/parent" };
const DEFAULT_TZ = "Asia/Kolkata";

/** Same shape as the Next app's SessionContext. */
export type SessionContext = {
  userId: string;
  email: string | null;
  profile: {
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    avatar_path: string | null;
    status: "active" | "inactive" | "suspended" | "pending_activation";
    institute_id: string | null;
  };
  roles: AppRole[];
  institute: { id: string; name: string; logo_path: string | null } | null;
  timezone: string;
};

type Row = SessionContext["profile"] & {
  auth_email: string | null;
  auth_phone: string | null;
  role_list: AppRole[] | null;
  inst_name: string | null;
  inst_logo: string | null;
  tz: string | null;
};

async function loadRow(userId: string): Promise<Row | null> {
  return sys.one<Row>(
    `select p.id, p.full_name, p.email, p.phone, p.avatar_path, p.status, p.institute_id,
            u.email as auth_email, u.phone as auth_phone,
            (select array_agg(r.role::text) from public.user_roles r where r.user_id = p.id and r.institute_id = p.institute_id) as role_list,
            i.name as inst_name, i.logo_path as inst_logo, s.timezone as tz
       from public.profiles p
       join auth.users u on u.id = p.id
       left join public.institutes i on i.id = p.institute_id
       left join public.institute_settings s on s.institute_id = p.institute_id
      where p.id = $1`,
    [userId],
  );
}

/** Loads profile + roles from protected tables (never from client input). Heals missing role links. */
export async function loadSessionContext(userId: string): Promise<SessionContext | null> {
  let row = await loadRow(userId);
  if (!row) return null;

  let roles: AppRole[] = [];
  if (row.status === "active" && row.institute_id) roles = ROLE_PRIORITY.filter((r) => row!.role_list?.includes(r));

  // Never auto-heal blocked accounts: that would undo an admin's suspension.
  if (roles.length === 0 && row.status !== "suspended" && row.status !== "inactive") {
    const healed = await healUserRoles(userId, row.auth_email ?? row.email, row.phone ?? row.auth_phone);
    if (healed) row = (await loadRow(userId))!;
    if (row.status === "active" && row.institute_id) roles = ROLE_PRIORITY.filter((r) => row!.role_list?.includes(r));
  }

  const { auth_email, auth_phone: _ap, role_list: _rl, inst_name, inst_logo, tz, ...profile } = row;
  void _ap;
  void _rl;
  const active = roles.length > 0;
  return {
    userId,
    email: auth_email ?? profile.email,
    profile,
    roles,
    institute: active && profile.institute_id && inst_name ? { id: profile.institute_id, name: inst_name, logo_path: inst_logo } : null,
    timezone: (active && tz) || DEFAULT_TZ,
  };
}

/**
 * Auto-heal / link roles when a user exists in user_roles, guardians, students or teachers
 * by profile id, email or phone. Returns true when anything was linked.
 * (Port of healUserRoles from the Next app.)
 */
export async function healUserRoles(userId: string, email?: string | null, phone?: string | null): Promise<boolean> {
  const e = email?.trim().toLowerCase() || null;
  const p = phone?.trim() || null;

  return asSystem(async (db) => {
    // 0. Already has roles somewhere -> activate profile in that institute and link people records by email.
    const existing = await db.one<{ institute_id: string }>(`select institute_id from public.user_roles where user_id = $1 limit 1`, [userId]);
    if (existing) {
      await db.q(
        `update public.profiles set institute_id = $2, status = case when status in ('suspended', 'inactive') then status else 'active' end, email = coalesce($3, email), phone = coalesce($4, phone) where id = $1`,
        [userId, existing.institute_id, e, p],
      );
      if (e) await linkByEmail(db, userId, existing.institute_id, e);
      return true;
    }

    // 1-3. Match a guardian, then a student, then a teacher.
    const kinds = [
      { table: "guardians", role: "parent" },
      { table: "students", role: "student" },
      { table: "teachers", role: "teacher" },
    ] as const;
    for (const k of kinds) {
      const person = await db.one<{ id: string; institute_id: string; full_name: string | null; email: string | null; phone: string | null }>(
        `select id, institute_id, full_name, email, phone from public.${k.table}
          where profile_id = $1 or ($2::text is not null and lower(email) = $2) or ($3::text is not null and phone = $3)
          limit 1`,
        [userId, e, p],
      );
      if (!person) continue;
      await db.q(
        `update public.profiles
            set institute_id = $2, status = case when status in ('suspended', 'inactive') then status else 'active' end, email = coalesce($3, $4, email),
                full_name = coalesce(nullif($5, ''), full_name), phone = coalesce($6, phone)
          where id = $1`,
        [userId, person.institute_id, e, person.email, person.full_name, person.phone],
      );
      await db.q(`update public.${k.table} set profile_id = $1 where id = $2`, [userId, person.id]);
      await db.q(
        `insert into public.user_roles (user_id, institute_id, role) values ($1, $2, $3) on conflict (user_id, institute_id, role) do nothing`,
        [userId, person.institute_id, k.role],
      );
      return true;
    }
    return false;
  });
}

async function linkByEmail(db: Db, userId: string, instituteId: string, email: string) {
  for (const t of ["guardians", "students", "teachers"]) {
    await db.q(`update public.${t} set profile_id = $1 where institute_id = $2 and lower(email) = $3 and profile_id is null`, [userId, instituteId, email]);
  }
}
