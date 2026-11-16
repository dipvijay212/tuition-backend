import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware.js";
import { h, paging, qs, withCount } from "../lib/route.js";
import { badRequest } from "../lib/errors.js";
import { publicBrandingUrl, signedUrl } from "../lib/storage.js";

export const OPTIONAL_TYPES = ["attendance_absence", "fee_reminder", "homework_assignment", "homework_deadline", "examination_announcement", "timetable_change", "general_announcement"];

export const notificationsRouter = Router();
notificationsRouter.use(requireRole("admin", "teacher", "student", "parent"));

/** Data the portal shell needs on every page (unread count, logo, avatar). */
notificationsRouter.get(
  "/shell",
  h(async ({ db, ctx }) => {
    const r = await db.one<{ unread: number; avatar_ok: boolean }>(
      `select (select count(*) from public.notifications where user_id = $1 and read_at is null)::int as unread,
              ($2::text is not null and public.can_read_file($2)) as avatar_ok`,
      [ctx.userId, ctx.profile.avatar_path],
    );
    return {
      unread: r?.unread ?? 0,
      avatarUrl: r?.avatar_ok && ctx.profile.avatar_path ? signedUrl(ctx.profile.avatar_path) : null,
      logoUrl: publicBrandingUrl(ctx.institute.logo_path),
    };
  }),
);

notificationsRouter.get(
  "/",
  h(async ({ req, db, ctx }) => {
    const { limit, offset } = paging(req, 25);
    const unreadOnly = qs(req, "filter") === "unread";
    const rows = await db.q<{ total_count: number }>(
      `select id, type, title, body, link, read_at, created_at, count(*) over() as total_count
         from public.notifications
        where user_id = $1 and ($2::boolean is false or read_at is null)
        order by created_at desc limit $3 offset $4`,
      [ctx.userId, unreadOnly, limit, offset],
    );
    const extra = await db.one<{ unread: number; prefs: { type: string; in_app: boolean }[] }>(
      `select (select count(*) from public.notifications where user_id = $1 and read_at is null)::int as unread,
              coalesce((select json_agg(json_build_object('type', type, 'in_app', in_app)) from public.notification_preferences where user_id = $1), '[]') as prefs`,
      [ctx.userId],
    );
    return { ...withCount(rows), unread: extra?.unread ?? 0, prefs: extra?.prefs ?? [] };
  }),
);

notificationsRouter.post(
  "/read-all",
  h(async ({ db, ctx }) => {
    await db.q(`update public.notifications set read_at = now() where user_id = $1 and read_at is null`, [ctx.userId]);
    return { message: "All marked as read" };
  }),
);

notificationsRouter.post(
  "/:id/read",
  h(async ({ req, db, ctx }) => {
    const id = z.uuid().parse(req.params.id);
    await db.q(`update public.notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null`, [id, ctx.userId]);
  }),
);

notificationsRouter.put(
  "/preferences",
  h(async ({ req, db, ctx }) => {
    const v = z.object({ type: z.string(), in_app: z.boolean() }).parse(req.body);
    if (!OPTIONAL_TYPES.includes(v.type)) throw badRequest("This notification type cannot be turned off.");
    await db.q(
      `insert into public.notification_preferences (user_id, type, in_app, email) values ($1, $2, $3, $3)
       on conflict (user_id, type) do update set in_app = excluded.in_app, email = excluded.email`,
      [ctx.userId, v.type, v.in_app],
    );
    return { message: "Preference saved" };
  }),
);
