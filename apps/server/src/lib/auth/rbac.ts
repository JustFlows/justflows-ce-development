export const ROLES = {
  ADMIN: "administrator",
  EDITOR: "editor",
  AUTHOR: "author",
  CONTRIBUTOR: "contributor",
  SUBSCRIBER: "subscriber",
} as const;

export type UserRole = (typeof ROLES)[keyof typeof ROLES];

/** Assignable roles shown in the new-user default role dropdown. */
export const USER_ROLE_VALUES = [
  ROLES.SUBSCRIBER,
  ROLES.CONTRIBUTOR,
  ROLES.AUTHOR,
  ROLES.EDITOR,
  ROLES.ADMIN,
] as const;

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLE_VALUES as readonly string[]).includes(value);
}

/** Id stored on `users.role`: a core role or a plugin-registered role. */
export const STORED_ROLE_ID = /^[a-z][a-z0-9-]{1,31}$/;

/** Roles that can access the admin content area (read). */
export const CONTENT_READ_ROLES = [
  ROLES.ADMIN,
  ROLES.EDITOR,
  ROLES.AUTHOR,
  ROLES.CONTRIBUTOR,
] as const;

/** Roles that can create or edit content (drafts). */
export const CONTENT_WRITE_ROLES = [
  ROLES.ADMIN,
  ROLES.EDITOR,
  ROLES.AUTHOR,
  ROLES.CONTRIBUTOR,
] as const;

/** Roles that can publish content. */
export const CONTENT_PUBLISH_ROLES = [ROLES.ADMIN, ROLES.EDITOR, ROLES.AUTHOR] as const;

/** Roles that can delete any content. */
export const CONTENT_DELETE_ANY_ROLES = [ROLES.ADMIN, ROLES.EDITOR] as const;

export const MENU_WRITE_ROLES = [ROLES.ADMIN, ROLES.EDITOR] as const;

export const MEDIA_WRITE_ROLES = [ROLES.ADMIN, ROLES.EDITOR, ROLES.AUTHOR] as const;

export const THEME_CUSTOMIZE_ROLES = [ROLES.ADMIN, ROLES.EDITOR] as const;

export function canPublish(role: string): boolean {
  return (CONTENT_PUBLISH_ROLES as readonly string[]).includes(role);
}

export function canDeleteAnyContent(role: string): boolean {
  return (CONTENT_DELETE_ANY_ROLES as readonly string[]).includes(role);
}

export function canViewRevisions(role: string): boolean {
  return (CONTENT_READ_ROLES as readonly string[]).includes(role);
}

export function canRestoreRevisions(role: string): boolean {
  return (CONTENT_WRITE_ROLES as readonly string[]).includes(role);
}

export function canDiscardDraft(role: string): boolean {
  return (CONTENT_WRITE_ROLES as readonly string[]).includes(role);
}
