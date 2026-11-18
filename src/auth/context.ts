import { asSystem, sys, type Db } from "../db/pool.js";

export type AppRole = "admin" | "teacher" | "student" | "parent";
export const ROLE_PRIORITY: AppRole[] = ["admin", "teacher", "parent", "student"];
export const ROLE_HOME: Record<AppRole, string> = { admin: "/admin", teacher: "/teacher", student: "/student", parent: "/parent" };
const DEFAULT_TZ = "Asia/Kolkata";

export type AccountStatus = "active" | "inactive" | "suspended" | "pending_activation";
/** trial/active/grace = full access; expired = read-only; suspended = blocked by the platform. */
export type Access = "trial" | "active" | "grace" | "expired" | "suspended";
export const FEATURES = ["exams", "homework", "materials"] as const;
export type Feature = (typeof FEATURES)[number];

export type SubscriptionInfo = {
  access: Access;
  readOnly: boolean;
  status: "trialing" | "active" | "cancelled" | null;
  plan: { code: string; name: string } | null;
  billingCycle: "monthly" | "yearly" | null;
  endsAt: string | null;
  daysLeft: number | null;
  features: Feature[];
  limits: { students: number | null; teachers: number | null; batches: number | null; storageMb: number | null };
};

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
    /** Status of this account in the session's institute. */
    status: AccountStatus;
    /** The session's institute. */
    institute_id: string | null;
  };
  roles: AppRole[];
  institute: { id: string; name: string; logo_path: string | null; code: string } | null;
  subscription: SubscriptionInfo | null;
  timezone: string;
  /** Platform staff session (super admin), not tied to an institute. */
  platform: boolean;
};

export type ContextRow = {
  session_id: string;
  user_id: string;
  persistent: boolean;
  last_seen_at: Date;
  session_inst: string | null;
  auth_email: string | null;
  auth_phone: string | null;
  full_name: string | null;
  p_email: string | null;
  p_phone: string | null;
  avatar_path: string | null;
  m_status: AccountStatus | null;
  role_list: AppRole[] | null;
  inst_name: string | null;
  inst_logo: string | null;
  inst_code: string | null;
  tz: string | null;
  access: Access | null;
  sub_status: SubscriptionInfo["status"];
  plan_code: string | null;
  plan_name: string | null;
  billing_cycle: SubscriptionInfo["billingCycle"];
  features: string[] | null;
  ends_at: Date | null;
  max_students: number | null;
  max_teachers: number | null;
  max_batches: number | null;
  storage_mb: number | null;
  is_platform: boolean;
};

/** Session token hash -> everything a request needs, in one round trip. */
export const CONTEXT_SQL = `
  select s.id as session_id, s.user_id, s.persistent, s.last_seen_at, s.institute_id as session_inst,
         u.email as auth_email, u.phone as auth_phone,
         p.full_name, p.email as p_email, p.phone as p_phone, p.avatar_path,
         m.status as m_status,
         (select array_agg(r.role::text) from public.user_roles r where r.user_id = s.user_id and r.institute_id = s.institute_id) as role_list,
         i.name as inst_name, i.logo_path as inst_logo, i.code as inst_code, st.timezone as tz,
         a.access, a.sub_status, a.plan_code, a.plan_name, a.billing_cycle, a.features, a.ends_at,
         a.max_students, a.max_teachers, a.max_batches, a.storage_mb,
         (s.platform and exists (select 1 from public.platform_admins pa where pa.user_id = s.user_id)) as is_platform
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    left join public.profiles p on p.id = s.user_id
    left join public.memberships m on m.user_id = s.user_id and m.institute_id = s.institute_id
    left join public.institutes i on i.id = s.institute_id
    left join public.institute_settings st on st.institute_id = s.institute_id
    left join public.institute_access a on a.institute_id = s.institute_id
   where s.token_hash = $1 and s.expires_at > now() and (u.banned_until is null or u.banned_until < now())`;

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildContext(row: ContextRow): SessionContext {
  const status: AccountStatus = row.is_platform ? "active" : (row.m_status ?? "pending_activation");
  const instOk = !!row.session_inst && !!row.inst_name;
  const roles = status === "active" && instOk ? ROLE_PRIORITY.filter((r) => row.role_list?.includes(r)) : [];
  const active = roles.length > 0;
  const access: Access = row.access ?? "expired";
  const endsAt = row.ends_at ? new Date(row.ends_at) : null;
  return {
    userId: row.user_id,
    email: row.auth_email ?? row.p_email,
    profile: {
      id: row.user_id,
      full_name: row.full_name ?? "",
      email: row.p_email,
      phone: row.p_phone ?? row.auth_phone,
      avatar_path: row.avatar_path,
      status,
      institute_id: row.session_inst,
    },
    roles,
    institute: active ? { id: row.session_inst!, name: row.inst_name!, logo_path: row.inst_logo, code: row.inst_code! } : null,
    subscription: instOk
      ? {
          access,
          readOnly: access === "expired" || access === "suspended",
          status: row.sub_status,
          plan: row.plan_code ? { code: row.plan_code, name: row.plan_name ?? row.plan_code } : null,
          billingCycle: row.billing_cycle,
          endsAt: endsAt?.toISOString() ?? null,
          daysLeft: endsAt ? Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / DAY_MS)) : null,
          features: (row.features ?? []).filter((f): f is Feature => (FEATURES as readonly string[]).includes(f)),
          limits: { students: row.max_students, teachers: row.max_teachers, batches: row.max_batches, storageMb: row.storage_mb },
        }
      : null,
    timezone: (active && row.tz) || DEFAULT_TZ,
    platform: row.is_platform,
  };
}

/** Membership + roles of a user in one institute (used at login / switch). */
export async function membershipOf(userId: string, instituteId: string) {
  return sys.one<{ status: AccountStatus; roles: AppRole[] | null }>(
    `select m.status, (select array_agg(r.role::text) from public.user_roles r where r.user_id = m.user_id and r.institute_id = m.institute_id) as roles
       from public.memberships m where m.user_id = $1 and m.institute_id = $2`,
    [userId, instituteId],
  );
}

/**
 * Auto-link a login to the people records of ONE institute (guardian, student or teacher matched by
 * profile id, email or phone), granting the matching role. Never looks at other institutes.
 * Returns true when anything was linked.
 */
export async function healUserRoles(userId: string, instituteId: string, email?: string | null, phone?: string | null): Promise<boolean> {
  const e = email?.trim().toLowerCase() || null;
  const p = phone?.trim() || null;

  return asSystem(async (db) => {
    const m = await db.one<{ status: AccountStatus }>(`select status from public.memberships where user_id = $1 and institute_id = $2`, [userId, instituteId]);
    // Never auto-heal blocked accounts: that would undo an admin's decision.
    if (m && (m.status === "suspended" || m.status === "inactive")) return false;

    let linked = false;
    const kinds = [
      { table: "guardians", role: "parent" },
      { table: "students", role: "student" },
      { table: "teachers", role: "teacher" },
    ] as const;
    for (const k of kinds) {
      const person = await db.one<{ id: string; full_name: string | null; email: string | null; phone: string | null }>(
        `select id, full_name, email, phone from public.${k.table}
          where institute_id = $4 and (profile_id = $1 or (profile_id is null and (($2::text is not null and lower(email) = $2) or ($3::text is not null and phone = $3))))
          order by (profile_id = $1) desc nulls last
          limit 1`,
        [userId, e, p, instituteId],
      );
      if (!person) continue;
      await db.q(`update public.${k.table} set profile_id = $1 where id = $2 and profile_id is null`, [userId, person.id]);
      await db.q(
        `insert into public.user_roles (user_id, institute_id, role) values ($1, $2, $3) on conflict (user_id, institute_id, role) do nothing`,
        [userId, instituteId, k.role],
      );
      await db.q(`update public.profiles set full_name = coalesce(nullif(full_name, ''), $2), phone = coalesce(phone, $3) where id = $1`, [userId, person.full_name, person.phone]);
      linked = true;
    }
    if (linked) await db.q(`update public.memberships set status = 'active' where user_id = $1 and institute_id = $2 and status = 'pending_activation'`, [userId, instituteId]);
    if (e) await linkByEmail(db, userId, instituteId, e);
    return linked;
  });
}

async function linkByEmail(db: Db, userId: string, instituteId: string, email: string) {
  for (const t of ["guardians", "students", "teachers"]) {
    await db.q(`update public.${t} set profile_id = $1 where institute_id = $2 and lower(email) = $3 and profile_id is null`, [userId, instituteId, email]);
  }
}
